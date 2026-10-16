'use strict';

const { createHash } = require('node:crypto');
const { bookingError } = require('./treatmentBookingProfile.service');
const READY = 'appointment.confirmation_undo_ready';
const UNDONE = 'appointment.confirmation_undone';
const SCHEMA = 'appointment-confirmation-undo/v1';
const CONFIRMED = new Set(['info_confirmada', 'recordatorio_confirmado']);
const REVERSIBLE = new Set([...CONFIRMED, 'ha_acudido']);
const CARE_FIELDS = ['arrived_at', 'arrived_by', 'care_started_at', 'care_started_by', 'care_completed_at', 'care_completed_by', 'care_schedule_start'];
const PRECARE = new Set(['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado', 'cambio_solicitado', 'reprogramada']);
const json = value => typeof value === 'string' ? JSON.parse(value) : value || {};
const plain = row => row?.toJSON ? row.toJSON() : { ...row };
const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const fail = (suffix, message, status = 409) => { throw bookingError(`appointment_confirmation_undo_${suffix}`, message, null, status); };
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function fingerprint(db, row) {
  const values = plain(row), fields = Object.keys(db.CitaPaciente.rawAttributes || values);
  return createHash('sha256').update(JSON.stringify(canonical(Object.fromEntries(fields.map(key => [key, values[key]]))))).digest('hex');
}
function preCare(row) {
  return PRECARE.has(row.estado) && !row.arrived_at && !row.care_started_at && !row.care_completed_at
    && !row.care_legacy_attendance && !row.es_provisional;
}
function reversibleAfter(row) {
  if (row.estado !== 'ha_acudido') return preCare(row);
  return !!row.arrived_at && !!row.care_schedule_start && +new Date(row.care_schedule_start) === +new Date(row.inicio)
    && !row.care_started_at && !row.care_completed_at && !row.care_legacy_attendance && !row.es_provisional;
}
function groupSnapshot(group) {
  return group ? { id: String(group.link.id), revision: Number(group.link.revision),
    members: group.rows.map(row => Number(row.id_cita)).sort((a, b) => a - b) } : null;
}

// The receipt is an immutable audit event, not an arbitrary state-write token.
// Its separate consumption event is serialized under receipt/appointment locks.
// Nothing here invokes an automation engine, notification delivery or provider.
function createAppointmentConfirmationUndoService({ db, now = () => new Date(),
  recordStatusChange = args => require('./appointmentActivity.service').recordAppointmentStatusChange(args),
  loadLinkedGroup = (...args) => require('./appointmentPatientLinks.service').load(db, ...args),
  restoreAppointment = null,
}) {
  const requireTx = tx => { if (!tx || tx.options?.isolationLevel !== 'READ COMMITTED') fail('unavailable', 'No se puede deshacer este cambio con seguridad.'); };
  async function record({ appointment, beforeRows, changedRows, actorId, transaction }) {
    requireTx(transaction);
    if (!db.PatientOperationalEvent || !id(actorId) || !REVERSIBLE.has(appointment.estado)) return null;
    const before = new Map((beforeRows || []).map(row => [Number(row.id_cita), plain(row)]));
    const candidates = (changedRows || []).filter(row => before.has(Number(row.id_cita))
      && before.get(Number(row.id_cita)).estado !== row.estado);
    if (!candidates.length || candidates.length > 10 || candidates.some(row => !preCare(before.get(Number(row.id_cita))) || !reversibleAfter(row))) return null;
    const group = await loadLinkedGroup(Number(appointment.id_cita), transaction, true);
    const rows = [];
    for (const candidate of candidates) {
      const current = await db.CitaPaciente.findByPk(candidate.id_cita, { transaction, lock: transaction.LOCK.UPDATE });
      if (!current || Number(current.clinica_id) !== Number(appointment.clinica_id)
        || Number(current.paciente_id) !== Number(appointment.paciente_id) || current.estado !== appointment.estado) return null;
      rows.push({ appointment_id: Number(current.id_cita), previous_status: before.get(Number(current.id_cita)).estado,
        previous_care: Object.fromEntries(CARE_FIELDS.map(key => [key, before.get(Number(current.id_cita))[key] ?? null])),
        new_status: current.estado, after_sha256: fingerprint(db, current) });
    }
    const guardedRows = [];
    for (const candidate of group?.rows || candidates) {
      const current = await db.CitaPaciente.findByPk(candidate.id_cita, { transaction, lock: transaction.LOCK.UPDATE });
      if (db.AppointmentClinicalReport && await db.AppointmentClinicalReport.findOne({ where: { appointment_id: current.id_cita },
        transaction, lock: transaction.LOCK.UPDATE })) return null;
      guardedRows.push({ appointment_id: Number(current.id_cita), after_sha256: fingerprint(db, current) });
    }
    const at = now(), expiresAt = new Date(+at + 30000);
    const event = await db.PatientOperationalEvent.create({ clinic_id: Number(appointment.clinica_id),
      patient_id: Number(appointment.paciente_id), actor_user_id: Number(actorId), event_type: READY, source: 'agenda', occurred_at: at,
      metadata: { schema: SCHEMA, appointment_id: Number(appointment.id_cita), expires_at: expiresAt.toISOString(),
        rows, guard_rows: guardedRows, linked_group: groupSnapshot(group) } }, { transaction });
    return { change_id: Number(event.id), appointment_id: Number(appointment.id_cita), expires_at: expiresAt.toISOString(),
      duration_ms: 20000, affected_count: rows.length };
  }
  async function restore(row, saved, actorId, transaction) {
    const previousStatus = saved.previous_status;
    if (restoreAppointment) return restoreAppointment({ appointment: row, previousStatus, previousCare: saved.previous_care, actorId, transaction });
    const changes = { estado: previousStatus, updated_by: actorId,
      ...(row.estado === 'ha_acudido' ? saved.previous_care : {}) };
    require('../lib/appointment-care').assertCareStatusChange(row, { ...plain(row), ...changes });
    const managed = db.AppointmentVisitMember && db.AppointmentVisit ? require('./appointmentVisitManaged.service').current() : null;
    const proof = managed ? await managed.prepareMutation({ appointmentId: Number(row.id_cita), clinicId: Number(row.clinica_id), actorId, transaction }) : null;
    const updated = await row.update(changes, { transaction });
    if (proof) await managed.persistMutation(proof, { appointment: updated, transaction, suppressCommunications: true });
    return updated;
  }
  async function undo({ appointmentId, changeId, clinicId, actorId }) {
    if (![appointmentId, changeId, clinicId, actorId].every(id)) fail('invalid', 'El cambio que quieres deshacer no es válido.', 400);
    return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const discovered = await db.PatientOperationalEvent.findByPk(changeId, { transaction });
      if (!discovered || discovered.event_type !== READY || json(discovered.metadata).schema !== SCHEMA) fail('unavailable', 'Este cambio no se puede deshacer.');
      if (Number(discovered.actor_user_id) !== Number(actorId) || Number(discovered.clinic_id) !== Number(clinicId)
        || Number(json(discovered.metadata).appointment_id) !== Number(appointmentId)) fail('forbidden', 'Sólo puedes deshacer tu propio cambio en esta clínica.', 403);
      const data = json(discovered.metadata);
      if (!Array.isArray(data.rows) || !data.rows.length || data.rows.length > 10 || !Array.isArray(data.guard_rows)
        || !data.guard_rows.length || data.guard_rows.length > 10) fail('unavailable', 'Este cambio no se puede deshacer.');
      if (!Number.isFinite(+new Date(data.expires_at)) || +now() >= +new Date(data.expires_at))
        fail('expired', 'Ha terminado el plazo para deshacer este cambio.');
      // Same lexical appointment/group lock order as the canonical state writer.
      const group = await loadLinkedGroup(Number(appointmentId), transaction, true);
      const currentRows = [];
      for (const saved of [...data.guard_rows].sort((a, b) => a.appointment_id - b.appointment_id)) {
        const row = await db.CitaPaciente.findByPk(saved.appointment_id, { transaction, lock: transaction.LOCK.UPDATE });
        if (!row) fail('changed', 'La cita ha cambiado. No se ha deshecho el cambio.');
        currentRows.push(row);
      }
      const receipt = await db.PatientOperationalEvent.findByPk(changeId, { transaction, lock: transaction.LOCK.UPDATE });
      const at = now();
      // Expired links never scan an ever-growing patient history. Recheck after
      // locks as well, so waiting for another writer cannot extend the window.
      if (+at >= +new Date(data.expires_at)) fail('expired', 'Ha terminado el plazo para deshacer este cambio.');
      const history = await db.PatientOperationalEvent.findAll({ where: { clinic_id: Number(clinicId), patient_id: Number(receipt.patient_id),
        id: { [db.Sequelize.Op.gt]: Number(changeId) }, event_type: { [db.Sequelize.Op.in]: [UNDONE, 'appointment.status_changed', 'appointment_care_changed'] } },
        order: [['id', 'ASC']], limit: 201, transaction });
      if (history.some(event => event.event_type === UNDONE && Number(json(event.metadata).change_id) === Number(changeId)))
        fail('used', 'Este cambio ya se ha deshecho.');
      if (history.length > 200) fail('changed', 'La cita ha cambiado. No se ha deshecho el cambio.');
      const ids = new Set(data.guard_rows.map(row => Number(row.appointment_id)));
      if (JSON.stringify(canonical(groupSnapshot(group))) !== JSON.stringify(canonical(data.linked_group))
        || history.some(event => ids.has(Number(json(event.metadata).appointment_id))))
        fail('changed', 'La cita ha cambiado. No se ha deshecho el cambio.');
      for (const row of currentRows) {
        const guard = data.guard_rows.find(value => Number(value.appointment_id) === Number(row.id_cita));
        const saved = data.rows.find(value => Number(value.appointment_id) === Number(row.id_cita));
        if (Number(row.clinica_id) !== Number(clinicId) || Number(row.paciente_id) !== Number(receipt.patient_id)
          || fingerprint(db, row) !== guard.after_sha256 || saved && (!REVERSIBLE.has(saved.new_status)
            || !PRECARE.has(saved.previous_status) || !reversibleAfter(row) || row.estado !== saved.new_status))
          fail('changed', 'La cita ha cambiado. No se ha deshecho el cambio.');
        if (db.AppointmentClinicalReport && await db.AppointmentClinicalReport.findOne({ where: { appointment_id: row.id_cita },
          transaction, lock: transaction.LOCK.UPDATE })) fail('changed', 'La cita ya tiene una atención clínica. No se ha deshecho su llegada.');
      }
      const changed = [];
      for (const row of currentRows) {
        const saved = data.rows.find(value => Number(value.appointment_id) === Number(row.id_cita));
        if (!saved) continue;
        const restored = await restore(row, saved, Number(actorId), transaction);
        if (saved.new_status === 'ha_acudido') {
          await db.AppointmentCareEvent.create({ appointment_id: row.id_cita, clinic_id: Number(clinicId), actor_id: Number(actorId),
            action: 'arrival_corrected', schedule_start: row.inicio, created_at: at }, { transaction });
          await db.PatientOperationalEvent.create({ patient_id: Number(receipt.patient_id), clinic_id: Number(clinicId),
            actor_user_id: Number(actorId), event_type: 'appointment_care_changed', source: 'agenda', occurred_at: at,
            metadata: { appointment_id: row.id_cita, action: 'arrival_corrected', confirmation_undo_change_id: Number(changeId),
              next_status: saved.previous_status, schedule_start: row.inicio, suppress_communications: true } }, { transaction });
        }
        await recordStatusChange({ appointment: restored, previousStatus: saved.new_status, newStatus: saved.previous_status,
          actorUserId: Number(actorId), source: 'agenda', occurredAt: at, transaction, eventModel: db.PatientOperationalEvent,
          metadata: { route: 'undoCitaConfirmation', confirmation_undo_change_id: Number(changeId), suppress_communications: true } });
        changed.push(restored);
      }
      await db.PatientOperationalEvent.create({ clinic_id: Number(clinicId), patient_id: Number(receipt.patient_id),
        actor_user_id: Number(actorId), event_type: UNDONE, source: 'agenda', occurred_at: at,
        metadata: { schema: SCHEMA, appointment_id: Number(appointmentId), change_id: Number(changeId),
          appointment_ids: [...ids], suppress_communications: true } }, { transaction });
      return { appointment: changed.find(row => Number(row.id_cita) === Number(appointmentId)), rows: changed };
    });
  }
  return { record, undo };
}
module.exports = { createAppointmentConfirmationUndoService, fingerprint, READY, UNDONE, SCHEMA };
