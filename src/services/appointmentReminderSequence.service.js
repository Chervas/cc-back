'use strict';

const { randomUUID } = require('node:crypto');
const c = require('../lib/appointment-reminder-sequence');
const calendar = require('../lib/availability-calendar');
const plain = row => row?.toJSON ? row.toJSON() : row;
const unavailable = error => ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR'].includes(error?.original?.code || error?.parent?.code);

// SQL-backed communication ownership, independent of optional AppointmentVisit
// tables. All locks acquired here are ledger locks; no queue, provider, patient,
// appointment or template-family mutations occur inside this service.
function createAppointmentReminderSequenceService({ db, now = () => new Date(), newId = randomUUID }) {
  for (const name of ['sequelize', 'CitaPaciente', 'Clinica', 'AppointmentReminderSequence', 'FlowExecutionV2', 'Message']) {
    if (!db?.[name]) c.fail('dependency_missing');
  }
  const { Op } = db.Sequelize || require('sequelize');
  const appointmentAttributes = ['id_cita', 'clinica_id', 'paciente_id', 'inicio', 'estado', 'es_provisional',
    'hold_expires_at', 'source_system', 'tipo_cita', 'motivo', 'titulo', 'import_metadata'];
  const txOptions = transaction => ({ transaction, hooks: false });
  const transact = (transaction, work) => transaction ? work(transaction)
    : db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, work);
  const decision = (context, allowed, reason, extra = {}) => ({ allowed, reason,
    sequence_id: context.sequence?.id || null, sequence_key: context.key,
    anchor_appointment_id: context.anchor_appointment_id, arrival_at: context.arrival_at,
    local_date: context.scope.local_date, clinic_id: context.scope.clinic_id, patient_id: context.scope.patient_id, ...extra });

  async function inspectAppointment({ appointment, transaction = null }) {
    const supplied = plain(appointment);
    if (!c.id(supplied?.id_cita)) c.fail('scope_invalid');
    // Caller projections may be old; a diagnostic/scheduling read must consult
    // the real reservation. A dispatch caller already owns its appointment lock.
    const current = plain(await db.CitaPaciente.findByPk(c.id(supplied.id_cita), { transaction, attributes: appointmentAttributes }));
    if (!current || c.id(current.clinica_id) !== c.id(supplied.clinica_id)
      || c.id(current.paciente_id) !== c.id(supplied.paciente_id)) c.fail('scope_changed');
    const clinic = plain(await db.Clinica.findByPk(c.id(current.clinica_id), { transaction,
      attributes: ['id_clinica', 'configuracion'] }));
    if (!clinic) c.fail('scope_changed');
    const scope = c.dayScope(current, calendar.resolveClinicTimezone(clinic));
    const rows = (await db.CitaPaciente.findAll({ where: { clinica_id: scope.clinic_id, paciente_id: scope.patient_id,
      inicio: { [Op.gte]: scope.starts_at, [Op.lt]: scope.ends_at } }, transaction,
      order: [['inicio', 'ASC'], ['id_cita', 'ASC']], attributes: appointmentAttributes })).map(plain);
    const anchor = c.selectAnchor(rows, scope), anchorId = c.id(anchor?.id_cita);
    const sequence = await db.AppointmentReminderSequence.findOne({ where: {
      clinic_id: scope.clinic_id, patient_id: scope.patient_id, local_date: scope.local_date }, transaction });
    if (sequence && sequence.time_zone !== scope.time_zone) c.fail('time_zone_changed');
    const follower = !anchorId || anchorId !== c.id(current.id_cita);
    const sameDay = rows.filter(row => row.estado !== 'cancelada' && !c.placeholder(row));
    return { appointment: current, appointments: rows, scope, key: c.sequenceKey(scope), anchor,
      anchor_appointment_id: anchorId, arrival_at: anchor ? c.instant(anchor.inicio) : null, follower,
      confirmedForReminder: sameDay.some(row => ['info_confirmada', 'recordatorio_confirmado', 'completada'].includes(row.estado)),
      attendanceConfirmed: sameDay.some(row => ['recordatorio_confirmado', 'ha_acudido', 'en_atencion', 'completada'].includes(row.estado)),
      reason: !anchorId ? 'appointment_day_no_arrival' : follower ? 'appointment_day_uses_first_arrival' : null, sequence };
  }

  async function lockSequence(context, transaction) {
    if (!context.anchor) return null;
    const where = { clinic_id: context.scope.clinic_id, patient_id: context.scope.patient_id,
      local_date: context.scope.local_date };
    // A native unique-key upsert serializes concurrent first claims without
    // Sequelize findOrCreate savepoints/duplicate insert deadlock retries. The
    // duplicate branch changes no existing delivery or timestamp evidence.
    await db.sequelize.query(`INSERT INTO AppointmentReminderSequences
      (id,clinic_id,patient_id,local_date,time_zone,anchor_appointment_id,arrival_at,claims,created_at,updated_at)
      VALUES (:id,:clinicId,:patientId,:localDate,:timeZone,:anchorId,:arrivalAt,JSON_OBJECT(),:now,:now)
      ON DUPLICATE KEY UPDATE id=id`, { transaction, replacements: { id: newId(), clinicId: where.clinic_id,
      patientId: where.patient_id, localDate: where.local_date, timeZone: context.scope.time_zone,
      anchorId: context.anchor_appointment_id, arrivalAt: new Date(context.arrival_at), now: new Date(now()) } });
    const sequence = await db.AppointmentReminderSequence.findOne({ where, transaction, lock: transaction.LOCK.UPDATE });
    if (!sequence || sequence.time_zone !== context.scope.time_zone) c.fail('time_zone_changed');
    c.claims(sequence.claims);
    context.sequence = sequence;
    return sequence;
  }

  // Only selected operational metadata is read, never message content, notes,
  // names or clinical documents. Existing attempted deliveries seal the stage
  // before a new execution can claim it, including a reservation moved off-day.
  async function priorHistory(context, transaction) {
    const ids = context.appointments.map(row => c.id(row.id_cita)).filter(Boolean);
    const [rows] = await db.sequelize.query(`SELECT e.id AS execution_id, e.trigger_entity_id AS appointment_id,
      e.trigger_type, e.status AS execution_status,
      JSON_UNQUOTE(JSON_EXTRACT(e.context,'$.appointment.inicio')) AS start_at,
      JSON_UNQUOTE(JSON_EXTRACT(e.context,'$.appointment.paciente_id')) AS context_patient_id,
      JSON_UNQUOTE(JSON_EXTRACT(e.context,'$.trigger.schedule_moment')) AS schedule_moment,
      JSON_EXTRACT(e.context,'$.whatsapp_no_response_timeout') AS context_timeout,
      JSON_UNQUOTE(JSON_EXTRACT(t.trigger_config,'$.schedule_moment')) AS template_moment,
      m.id AS message_id, m.status, m.sent_at,
      JSON_EXTRACT(m.metadata,'$.appointment_timeout') AS appointment_timeout,
      JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.template_name')) AS template_name,
      JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.fallback_template_name')) AS fallback_template_name,
      JSON_EXTRACT(m.metadata,'$.wamid') AS wamid,
      (JSON_EXTRACT(m.metadata,'$.wa_response') IS NOT NULL
        AND JSON_TYPE(JSON_EXTRACT(m.metadata,'$.wa_response'))<>'NULL') AS wa_response,
      JSON_EXTRACT(m.metadata,'$.provider_acceptance_at') AS provider_acceptance_at,
      JSON_EXTRACT(m.metadata,'$.delivery_unknown') AS delivery_unknown,
      JSON_EXTRACT(m.metadata,'$.outcome_unknown') AS outcome_unknown,
      JSON_EXTRACT(m.metadata,'$.network_started_at') AS network_started_at
      FROM Conversations cv INNER JOIN Messages m ON m.conversation_id=cv.id
      INNER JOIN FlowExecutionsV2 e ON e.id=CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.execution_id')) AS UNSIGNED)
      LEFT JOIN AutomationFlowTemplatesV2 t ON t.id=e.template_version_id
      WHERE cv.clinic_id=:clinicId AND cv.patient_id=:patientId AND e.clinic_id=:clinicId
        AND e.trigger_entity_type='appointment' AND m.direction='outbound' AND m.message_type<>'event'
        AND (e.trigger_entity_id IN (:appointmentIds) OR
          (CAST(JSON_UNQUOTE(JSON_EXTRACT(e.context,'$.appointment.paciente_id')) AS UNSIGNED)=:patientId
            AND JSON_UNQUOTE(JSON_EXTRACT(e.context,'$.appointment.inicio')) >= :startsAt
            AND JSON_UNQUOTE(JSON_EXTRACT(e.context,'$.appointment.inicio')) < :endsAt))
      ORDER BY m.id ASC LIMIT 1001`, { transaction, replacements: { clinicId: context.scope.clinic_id,
      patientId: context.scope.patient_id, appointmentIds: ids.length ? ids : [0],
      startsAt: c.instant(context.scope.starts_at), endsAt: c.instant(context.scope.ends_at) } });
    if (rows.length > 1000) c.fail('history_requires_review');
    const history = [];
    const json = value => {
      if (value == null) return value;
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); } catch { return value; }
    };
    for (const row of rows) {
      if (row.trigger_type !== 'appointment_reminder_window') continue;
      const capturedTimeout = json(row.appointment_timeout);
      // Initial messages freeze false before the execution later times out.
      // Keep that immutable receipt; only missing old metadata may fall back
      // to the execution timeout flag, never relabel an earlier normal send.
      const timeout = [true, 1, 'true', '1'].includes(capturedTimeout)
        || capturedTimeout == null && [true, 1, 'true', '1'].includes(json(row.context_timeout));
      const named = /^clinicaclick_recordatorio_(semana_antes|dia_antes|mismo_dia)(?:_|$)/.exec(row.template_name || row.fallback_template_name || '');
      const stage = timeout ? 'no_response' : named
        ? ({ semana_antes: 'week_before', dia_antes: 'day_before', mismo_dia: 'same_day' })[named[1]] : null;
      if (!stage) continue; // Booking/cancellation/clinical communication is independent.
      if (!c.STAGES.includes(stage)) c.fail('history_requires_review');
      if (row.context_patient_id && c.id(row.context_patient_id) !== context.scope.patient_id) c.fail('history_scope_changed');
      // An immutable source start determines the communication day, not the
      // current slot after a reschedule. Unknown old snapshots are held safely.
      if (!row.start_at) c.fail('history_requires_review');
      const historyDay = calendar.formatDateLocal(new Date(c.instant(row.start_at)), context.scope.time_zone);
      if (historyDay !== context.scope.local_date) continue;
      history.push({ execution_id: c.id(row.execution_id), appointment_id: c.id(row.appointment_id), stage,
        message_id: c.id(row.message_id), status: row.status, sent_at: row.sent_at,
        metadata: { ...Object.fromEntries(['wamid', 'provider_acceptance_at', 'delivery_unknown',
          'outcome_unknown', 'network_started_at'].map(key => [key, json(row[key])])),
        // This column is a SQL existence predicate, not the provider response
        // itself. MySQL returns 0/1; numeric zero is not an attempted delivery.
        wa_response: Number(row.wa_response) === 1 } });
    }
    return history;
  }

  async function adoptAttemptedHistory(context, claims, transaction) {
    const history = await priorHistory(context, transaction);
    for (const stage of c.STAGES) {
      const attempted = history.filter(row => row.stage === stage && c.everAttempted(row));
      if (!attempted.length) continue;
      const first = attempted[0], prior = claims[stage];
      if (prior && (prior.execution_id !== first.execution_id || prior.message_id != null && prior.message_id !== first.message_id)) {
        // Do not rewrite evidence or grant one of several already attempted
        // historical executions permission to send another message.
        c.fail('history_requires_review');
      }
      claims[stage] = { execution_id: first.execution_id, appointment_id: first.appointment_id,
        claimed_at: prior?.claimed_at || c.instant(now()), message_id: first.message_id,
        attempted: true, adopted_history: true };
    }
    return history;
  }

  async function executionFor(context, executionId, transaction, { allowCompleted = false } = {}) {
    const execution = plain(await db.FlowExecutionV2.findByPk(c.id(executionId), { transaction }));
    const snapshot = c.object(execution?.context).appointment;
    if (!execution || !(allowCompleted ? ['running', 'waiting', 'completed'] : ['running', 'waiting']).includes(execution.status)) c.fail('execution_inactive');
    if (execution.trigger_entity_type !== 'appointment'
      || c.id(execution.clinic_id) !== context.scope.clinic_id
      || c.id(execution.trigger_entity_id) !== c.id(context.appointment.id_cita)
      || c.id(snapshot?.paciente_id) !== context.scope.patient_id || c.id(snapshot?.clinica_id) !== context.scope.clinic_id
      || c.instant(snapshot?.inicio) !== c.instant(context.appointment.inicio)) c.fail('execution_scope_changed');
    return execution;
  }

  async function canReplace(prior, context, history, transaction) {
    if (prior.attempted || history.some(row => row.execution_id === prior.execution_id && c.everAttempted(row))) return false;
    const old = plain(await db.FlowExecutionV2.findByPk(prior.execution_id, { transaction }));
    if (!old) c.fail('ledger_corrupt');
    const snapshot = c.object(old.context).appointment;
    const stale = c.id(old.trigger_entity_id) !== context.anchor_appointment_id
      || snapshot?.inicio && c.instant(snapshot.inicio) !== context.arrival_at;
    // Only a definitely unattempted cancelled/stale reservation loses its
    // reservation claim. Sending, accepted and uncertain claims never expire.
    return ['cancelled', 'failed', 'dead_letter'].includes(old.status) || stale;
  }

  async function recordResponse(context, execution, history, transaction) {
    const sequence = context.sequence;
    if (context.attendanceConfirmed && !sequence.attendance_confirmed_at) {
      await sequence.update({ attendance_confirmed_at: now() }, txOptions(transaction));
    }
    if (sequence.response_message_id) return true;
    const executionIds = [...new Set([c.id(execution.id), ...history.map(row => row.execution_id),
      ...Object.values(c.claims(sequence.claims)).map(row => row.execution_id)])];
    const executions = await db.FlowExecutionV2.findAll({ where: { id: { [Op.in]: executionIds } },
      attributes: ['id', 'context'], transaction, raw: true });
    const replyIds = [];
    for (const row of executions) {
      const stored = c.object(row.context);
      const explicit = c.id(stored.last_response_context?.response_message_id || stored.last_response_context?.inbound_message_id);
      if (explicit) replyIds.push(explicit);
      for (const output of Object.values(c.object(stored.outputs))) {
        const receipt = c.id(output?.response_message_id);
        if (receipt) replyIds.push(receipt);
      }
    }
    if (!replyIds.length) return false;
    const [receipts] = await db.sequelize.query(`SELECT m.id FROM Messages m
      INNER JOIN Conversations cv ON cv.id=m.conversation_id
      WHERE m.id IN (:ids) AND m.direction='inbound' AND cv.patient_id=:patientId AND cv.clinic_id=:clinicId
      ORDER BY m.id ASC LIMIT 1`, { transaction, replacements: { ids: [...new Set(replyIds)],
      patientId: context.scope.patient_id, clinicId: context.scope.clinic_id } });
    if (!receipts.length) return false;
    await sequence.update({ response_message_id: c.id(receipts[0].id), response_received_at: now() }, txOptions(transaction));
    return true;
  }

  // Explicit operator repair only; never run by a timer or during dispatch.
  // Remove an adopted booking receipt only with its original scoped evidence.
  async function reconcileBookingHistory({ appointment, apply = false, transaction = null }) {
    return transact(transaction, async tx => {
      const context = await inspectAppointment({ appointment, transaction: tx });
      if (!context.sequence) return { changed: false };
      const sequence = await db.AppointmentReminderSequence.findByPk(context.sequence.id, { transaction: tx, lock: tx.LOCK.UPDATE });
      const before = { claims: c.claims(sequence.claims), response_message_id: sequence.response_message_id,
        response_received_at: sequence.response_received_at };
      const claims = c.claims(before.claims), removed = [];
      for (const [stage, claim] of Object.entries(claims)) {
        const owner = plain(await db.FlowExecutionV2.findByPk(claim.execution_id, { transaction: tx }));
        if (!owner || !['appointment_created', 'appointment_rescheduled'].includes(owner.trigger_type)) continue;
        const captured = c.object(owner.context).appointment;
        const message = plain(await db.Message.findByPk(claim.message_id, { transaction: tx }));
        const conversation = message && plain(await db.Conversation.findByPk(message.conversation_id, { transaction: tx }));
        if (!claim.adopted_history || !message || message.direction !== 'outbound'
          || c.id(c.object(message.metadata).execution_id) !== c.id(owner.id)
          || owner.trigger_entity_type !== 'appointment' || c.id(owner.trigger_entity_id) !== claim.appointment_id
          || c.id(owner.clinic_id) !== context.scope.clinic_id || c.id(captured?.paciente_id) !== context.scope.patient_id
          || calendar.formatDateLocal(new Date(c.instant(captured?.inicio)), context.scope.time_zone) !== context.scope.local_date
          || c.id(conversation?.clinic_id) !== context.scope.clinic_id || c.id(conversation?.patient_id) !== context.scope.patient_id) c.fail('history_requires_review');
        removed.push({ stage, claim, owner }); delete claims[stage];
      }
      if (!removed.length) return { changed: false };
      let responseId = before.response_message_id, responseAt = before.response_received_at;
      if (responseId) {
        const references = row => {
          const context = c.object(row.context);
          return [context.last_response_context?.response_message_id, context.last_response_context?.inbound_message_id,
            ...Object.values(c.object(context.outputs)).map(o => o?.response_message_id)].map(c.id).filter(Boolean);
        };
        const history = await priorHistory(context, tx);
        const reminders = await db.FlowExecutionV2.findAll({ where: { id: { [Op.in]: [...new Set(history.map(h => h.execution_id))] } },
          attributes: ['id', 'context'], transaction: tx, raw: true });
        const reply = plain(await db.Message.findByPk(responseId, { transaction: tx }));
        const conversation = reply && plain(await db.Conversation.findByPk(reply.conversation_id, { transaction: tx }));
        const attempted = history.filter(c.everAttempted);
        const sends = attempted.length ? await db.Message.findAll({ where: { id: { [Op.in]: attempted.map(h => h.message_id) } },
          attributes: ['id', 'createdAt'], transaction: tx, raw: true }) : [];
        const times = sends.map(m => m.createdAt instanceof Date ? +m.createdAt : NaN);
        if (removed.some(r => references(r.owner).includes(c.id(responseId)))
          && !reminders.some(r => references(r).includes(c.id(responseId)))
          && reply?.direction === 'inbound' && c.id(conversation?.clinic_id) === context.scope.clinic_id
          && c.id(conversation?.patient_id) === context.scope.patient_id && reply.createdAt instanceof Date
          && times.length === attempted.length && times.length && times.every(Number.isFinite)
          && +reply.createdAt + 120000 < Math.min(...times)) { responseId = null; responseAt = null; }
      }
      const after = { claims, response_message_id: responseId, response_received_at: responseAt };
      if (apply) await sequence.update(after, txOptions(tx));
      return { changed: true, applied: apply, sequence_id: sequence.id, before, after,
        excluded: removed.map(r => ({ stage: r.stage, execution_id: r.owner.id, message_id: r.claim.message_id })) };
    });
  }

  async function claim(context, execution, stage, transaction) {
    c.stageKey(stage);
    const sequence = await lockSequence(context, transaction);
    if (!sequence) return decision(context, false, 'appointment_day_no_arrival', { stage_key: stage });
    const claims = c.claims(sequence.claims), before = JSON.stringify(claims);
    const history = await adoptAttemptedHistory(context, claims, transaction);
    const responded = await recordResponse(context, execution, history, transaction);
    let prior = claims[stage];
    const executionId = c.id(execution.id), appointmentId = c.id(context.appointment.id_cita);
    let allowed = true, reason = null;
    if (prior && prior.execution_id !== executionId) {
      if (!context.follower && await canReplace(prior, context, history, transaction)) prior = null;
      else { allowed = false; reason = 'appointment_day_stage_already_owned'; }
    }
    if (context.follower) { allowed = false; reason = 'appointment_day_uses_first_arrival'; }
    if (stage === 'no_response' && (responded || sequence.attendance_confirmed_at)) {
      allowed = false; reason = responded ? 'appointment_day_patient_already_replied' : 'appointment_day_attendance_confirmed';
    }
    if (!prior && allowed) claims[stage] = { execution_id: executionId, appointment_id: appointmentId,
      claimed_at: c.instant(now()), message_id: null, attempted: false };
    if (JSON.stringify(claims) !== before) await sequence.update({ claims }, txOptions(transaction));
    // Arrival projection may change without creating a new sequence/stage.
    if (!context.follower && (Number(sequence.anchor_appointment_id) !== context.anchor_appointment_id
      || c.instant(sequence.arrival_at) !== context.arrival_at)) {
      await sequence.update({ anchor_appointment_id: context.anchor_appointment_id, arrival_at: context.arrival_at }, txOptions(transaction));
    }
    return decision(context, allowed, reason, { stage_key: stage,
      execution_id: claims[stage]?.execution_id || null, message_id: claims[stage]?.message_id || null });
  }

  async function claimExecution({ appointment, executionId, scheduleMoment, transaction = null }) {
    if (!['week_before', 'day_before', 'same_day'].includes(scheduleMoment) || !c.id(executionId)) c.fail('stage_invalid');
    try {
      return await transact(transaction, async tx => {
        const context = await inspectAppointment({ appointment, transaction: tx });
        const execution = await executionFor(context, executionId, tx);
        if (c.executionStage(execution) !== scheduleMoment) c.fail('stage_changed');
        return claim(context, execution, scheduleMoment, tx);
      });
    } catch (error) { if (unavailable(error)) c.fail('unavailable'); throw error; }
  }

  async function authorizeMessage({ appointment, execution: supplied, messageId, stageKey = null, transaction = null }) {
    if (!c.id(supplied?.id) || !c.id(messageId)) c.fail('message_invalid');
    try {
      return await transact(transaction, async tx => {
        const context = await inspectAppointment({ appointment, transaction: tx });
        const execution = await executionFor(context, supplied.id, tx, { allowCompleted: true });
        const message = plain(await db.Message.findByPk(c.id(messageId), { transaction: tx }));
        const metadata = c.object(message?.metadata);
        if (!message || message.direction !== 'outbound' || message.message_type === 'event'
          || c.id(metadata.execution_id) !== c.id(execution.id)) c.fail('message_scope_changed');
        if (!db.Conversation) c.fail('dependency_missing');
        const conversation = plain(await db.Conversation.findByPk(c.id(message.conversation_id), { transaction: tx }));
        if (!conversation || c.id(conversation.clinic_id) !== context.scope.clinic_id
          || c.id(conversation.patient_id) !== context.scope.patient_id) c.fail('message_scope_changed');
        const stage = c.messageStage({ execution, message, stageKey });
        if (!stage) return { allowed: true, skipped: true, reason: 'not_appointment_reminder_message' };
        const result = await claim(context, execution, stage, tx);
        if (!result.allowed) return result;
        const claims = c.claims(context.sequence.claims), prior = claims[stage];
        if (prior.message_id && prior.message_id !== c.id(messageId)) {
          return decision(context, false, 'appointment_day_stage_message_already_owned', {
            stage_key: stage, execution_id: prior.execution_id, message_id: prior.message_id });
        }
        claims[stage] = { ...prior, message_id: c.id(messageId), attempted: true };
        await context.sequence.update({ claims }, txOptions(tx));
        return decision(context, true, null, { stage_key: stage, execution_id: c.id(execution.id), message_id: c.id(messageId) });
      });
    } catch (error) { if (unavailable(error)) c.fail('unavailable'); throw error; }
  }

  return Object.freeze({ inspectAppointment, claimExecution, authorizeMessage, reconcileBookingHistory });
}
let singleton;
function current() {
  if (!singleton) singleton = createAppointmentReminderSequenceService({ db: require('../../models') });
  return singleton;
}
module.exports = { createAppointmentReminderSequenceService, current };
