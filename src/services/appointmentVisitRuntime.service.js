'use strict';

const { randomUUID } = require('node:crypto');
const v = require('../lib/appointment-visit-communication');
const r = require('../lib/appointment-visit-runtime-contract');
const inboxHealth = require('../lib/whatsappInboxHealth');
const { createAppointmentVisitCommunicationService } = require('./appointmentVisitCommunications.service');

// Explicit bridge. The canonical writer is a SERVER composition dependency,
// never an HTTP field; only its sealed persist closure can create/enroll a row.
// No consumers, provider, enqueue or automatic historical adoption here.
function createAppointmentVisitRuntimeService({ db, now = () => new Date(), newId = randomUUID,
  rolloutEnabled = () => process.env.APPOINTMENT_VISIT_COMMUNICATIONS_V1_ENABLED === 'true',
  bookCanonicalBirth = null, foundation = createAppointmentVisitCommunicationService({ db, now, newId }),
  readInboxHealth = inboxHealth.read,
  assertExecutionActive = (...args) => require('../lib/automation-runtime-stop').assertExecutionActive(...args) }) {
  for (const model of ['AppointmentVisitBirthRequest', 'AppointmentVisit', 'AppointmentVisitCommunication', 'CitaPaciente', 'FlowExecutionV2', 'AutomationFlowTemplateV2']) {
    if (!db?.[model]) throw Error('appointment_visit_runtime_dependency_missing:' + model);
  }
  const opts = transaction => ({ transaction, hooks: false });
  const mutations = new WeakMap();
  const transact = (supplied, work) => {
    const execute = transaction => {
      if (transaction?.options?.isolationLevel !== 'READ COMMITTED' || !transaction.LOCK?.UPDATE) r.fail('transaction_invalid');
      return work(transaction);
    };
    return supplied ? execute(supplied) : db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, execute);
  };
  const scope = (clinicId, actorId = null) => {
    if (!v.positiveId(clinicId) || actorId != null && !v.positiveId(actorId)) r.fail('scope_invalid');
  };
  const planFor = appointment => ({ start_at: appointment.inicio, end_at: appointment.fin, treatment_id: appointment.tratamiento_id,
    doctor_id: appointment.doctor_id, installation_id: appointment.instalacion_id, booking: v.object(appointment.import_metadata).booking,
    ...(v.object(appointment.import_metadata).additional_staff ? { additional_staff: v.object(appointment.import_metadata).additional_staff } : {}) });
  async function verifyGraphs(contract, transaction) {
    for (const manifest of contract.manifests) {
      const current = await db.AutomationFlowTemplateV2.findByPk(manifest.template_version_id, { transaction });
      if (!current || current.is_active !== true || !current.published_at || r.graphHash(current) !== manifest.graph_sha256) r.fail('graph_changed');
    }
  }
  async function mutationEventFor(visit, transaction) {
    if (!db.PatientOperationalEvent) r.fail('mutation_event_required');
    const rows = await db.PatientOperationalEvent.findAll({ where: { clinic_id: Number(visit.clinic_id), patient_id: Number(visit.patient_id),
      event_type: r.MUTATION_EVENT, source: 'appointment_visit_runtime', metadata: { mutation: { visit_id: visit.id,
        communication_revision: Number(visit.communication_revision) } } }, order: [['id', 'DESC']], limit: 2, transaction });
    if (rows.length !== 1) r.fail('mutation_event_required');
    return { event: rows[0], proof: r.captureMutationReceipt(rows[0], visit) };
  }
  async function assertCommunicationMutation({ visit, communication, transaction }) {
    const stage = v.object(communication.runtime_stage);
    if (Number(communication.communication_revision) === 1 || !['details', 'cancellation', 'attendance_day_before', 'attendance_same_day'].includes(stage.stage_key)) return;
    const { event, proof } = await mutationEventFor(visit, transaction), receipt = r.mutationReceipt(proof, visit);
    if (stage.mutation_event_id !== String(event.id) || stage.mutation_event_sha256 !== receipt.event_sha256
      || Number(communication.created_by) !== receipt.actor_id
      || stage.stage_key === 'details' && (receipt.kind !== 'rescheduled' || receipt.suppressed)
      || stage.stage_key === 'cancellation' && (receipt.kind !== 'cancelled' || receipt.suppressed)
      || stage.stage_key.startsWith('attendance_') && !['rescheduled', 'lifecycle_changed'].includes(receipt.kind)) r.fail('mutation_receipt_invalid');
  }
  // This seam is called only by the canonical writer while it owns the SQL
  // appointment lock. Its proof cannot survive serialization, another service
  // factory or a different/finished transaction. There is no lazy enrollment.
  async function prepareCanonicalMutation({ appointmentId, clinicId, actorId, transaction }) {
    scope(clinicId, actorId);
    if (!transaction || !v.positiveId(appointmentId)) r.fail('mutation_transaction_required');
    return transact(transaction, async tx => {
      const appointment = await db.CitaPaciente.findByPk(appointmentId, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!appointment || Number(appointment.clinica_id) !== clinicId) r.fail('scope_invalid');
      if (!db.AppointmentVisitMember) return null;
      const member = await db.AppointmentVisitMember.findByPk(appointmentId, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!member) return null;
      const visit = await db.AppointmentVisit.findByPk(member.visit_id, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!visit?.runtime_enrollment) return null;
      r.assertStoredEnrollment(visit);
      if (!v.positiveId(actorId) || Number(visit.owner_appointment_id) !== appointmentId || Number(visit.clinic_id) !== clinicId
        || Number(visit.patient_id) !== Number(appointment.paciente_id)) r.fail('scope_invalid');
      const members = await db.AppointmentVisitMember.findAll({ where: { visit_id: visit.id }, transaction: tx, lock: tx.LOCK.UPDATE });
      const projection = v.buildVisitSnapshot({ visitId: visit.id, ownerAppointmentId: appointmentId, appointments: [appointment],
        members, groupingKind: visit.grouping_kind, evidence: visit.grouping_evidence });
      v.assertCurrentProjection({ visit, projection, expectedRevision: Number(visit.communication_revision) });
      const token = Object.freeze({ schema: 'appointment-visit-canonical-mutation/1' });
      mutations.set(token, { tx, appointmentId, clinicId, patientId: Number(appointment.paciente_id), actorId,
        visitId: visit.id, revision: Number(visit.communication_revision), projection: v.clone(projection), members: members.map(v.plain) });
      return token;
    });
  }
  async function persistCanonicalMutation(token, { appointment, transaction, communicationEnabled = rolloutEnabled() === true,
    registeredManifests = null, suppressCommunications = false }) {
    const proof = mutations.get(token);
    if (!proof || proof.tx !== transaction || transaction?.finished || Number(appointment?.id_cita) !== proof.appointmentId) r.fail('server_mutation_proof_required');
    return transact(transaction, async tx => {
      const row = await db.CitaPaciente.findByPk(proof.appointmentId, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!row || Number(row.clinica_id) !== proof.clinicId || Number(row.paciente_id) !== proof.patientId) r.fail('scope_changed');
      const visit = await db.AppointmentVisit.findByPk(proof.visitId, { transaction: tx, lock: tx.LOCK.UPDATE });
      const enrollment = r.assertStoredEnrollment(visit);
      v.assertCurrentProjection({ visit, projection: proof.projection, expectedRevision: proof.revision });
      const projected = v.buildVisitSnapshot({ visitId: visit.id, ownerAppointmentId: proof.appointmentId, appointments: [row],
        members: proof.members, groupingKind: visit.grouping_kind, evidence: visit.grouping_evidence });
      if (projected.snapshot_sha256 === proof.projection.snapshot_sha256) return { changed: false, visit, communication: null };
      if (projected.membership_sha256 !== proof.projection.membership_sha256) r.fail('membership_changed');
      const before = proof.projection.snapshot.reservations[0], after = projected.snapshot.reservations[0];
      const changedReservation = v.canonical({ ...before, lifecycle: null }) !== v.canonical({ ...after, lifecycle: null });
      const kind = after.lifecycle === 'cancelada' ? 'cancelled'
        : after.lifecycle === 'active' && (changedReservation || before.lifecycle === 'cancelada') ? 'rescheduled' : 'lifecycle_changed';
      const reason = require('../lib/appointment-reschedule-reason').RESCHEDULE_REASONS.includes(row.reschedule_reason) ? row.reschedule_reason : null;
      const suppressed = suppressCommunications === true || kind === 'rescheduled' && reason === 'administrative_error';
      const event = { schema: 'appointment-visit-mutation/1', visit_id: visit.id, owner_appointment_id: proof.appointmentId,
        actor_id: proof.actorId, before_revision: proof.revision, communication_revision: proof.revision + 1, kind,
        before_snapshot_sha256: proof.projection.snapshot_sha256, before_snapshot: proof.projection.snapshot,
        ...projected, recorded_at: v.instant(now()), reason, suppressed };
      // Final family/job authorization never locks after appointment ownership.
      // Cancel only old intent/dispatch/Message rights here; pending flow/jobs
      // subsequently fail their revision guard. Accepted and uncertain attempts
      // are retained as historical rights, never turned into retry permission.
      const old = await db.AppointmentVisitCommunication.findAll({ where: { visit_id: visit.id }, transaction: tx,
        order: [['created_at', 'ASC'], ['id', 'ASC']] });
      if (old.length) {
        const dispatch = require('./appointmentVisitDispatch.service').createAppointmentVisitDispatchService({ db, now, foundation });
        for (const communication of old) {
          if (Number(communication.communication_revision) > proof.revision) r.fail('revision_changed');
          await dispatch.cancelIntent({ communicationId: communication.id, clinicId: proof.clinicId, reason: 'visit_revision_changed', transaction: tx });
        }
      }
      const refreshed = await foundation.refreshVisitSnapshot({ visitId: visit.id, clinicId: proof.clinicId,
        expectedRevision: proof.revision, actorId: proof.actorId, transaction: tx });
      if (!refreshed.changed || Number(refreshed.visit.communication_revision) !== event.communication_revision) r.fail('revision_changed');
      if (!db.PatientOperationalEvent) r.fail('mutation_guard_unavailable');
      const recorded = await db.PatientOperationalEvent.create({ clinic_id: proof.clinicId, patient_id: proof.patientId, actor_user_id: proof.actorId,
        event_type: r.MUTATION_EVENT, source: 'appointment_visit_runtime', occurred_at: new Date(event.recorded_at),
        metadata: { mutation: event, mutation_sha256: v.hash(event) } }, { transaction: tx });
      const result = { changed: true, visit: refreshed.visit, event: recorded, communication: null };
      if (suppressCommunications === true) return { ...result, communication_held: 'appointment_restoration_silent' };
      if (!communicationEnabled) return { ...result, communication_held: 'visit_rollout_closed' };
      // Reminder ownership is independent of a suppressed immediate movement
      // notice. Old revisions were retired above; a future reminder for this
      // new active revision must exist DURABLY before the mutation commits.
      const reminderResult = after.lifecycle === 'active' ? await planReminderCommunications({ visit: refreshed.visit,
        actorId: proof.actorId, registeredManifests, transaction: tx }) : { planned: 0, held: [] };
      result.reminders = reminderResult;
      if (suppressed) return { ...result, communication_held: 'appointment_notification_suppressed' };
      const trigger = kind === 'rescheduled' ? 'appointment_rescheduled' : kind === 'cancelled' ? 'appointment_cancelled' : null;
      const stageKey = kind === 'cancelled' ? 'cancellation' : 'details';
      const manifest = trigger && enrollment.manifests.find(item => item.trigger_type === trigger && item.stages.some(stage => stage.key === stageKey)
        && (registeredManifests == null || registeredManifests.some(registered => r.reviewedManifestMatches(item, registered, proof.clinicId))));
      if (!manifest) return { ...result, communication_held: 'visit_mutation_manifest_unavailable' };
      const template = await db.AutomationFlowTemplateV2.findByPk(manifest.template_version_id, { transaction: tx });
      if (!template || template.is_active !== true || !template.published_at || r.graphHash(template) !== manifest.graph_sha256)
        return { ...result, communication_held: 'visit_mutation_graph_changed' };
      // Eligibility/HOLD/opt-out are communication gates, not a reason to undo
      // a patient's valid movement. SQL errors still abort the whole command.
      try {
        const intent = await planVisitCommunication({ visitId: visit.id, clinicId: proof.clinicId, expectedRevision: event.communication_revision,
          stageKey, templateVersionId: manifest.template_version_id, actorId: proof.actorId, transaction: tx });
        return { ...result, communication: intent.communication };
      } catch (error) {
        if (error?.name?.startsWith('Sequelize') || error?.original?.code || !String(error.code || '').startsWith('appointment_visit_')) throw error;
        return { ...result, communication_held: error.code };
      }
    });
  }
  async function createCanonicalBirth({ clinicId, patientId, actorId, requestKey, plan, contract: token, transaction = null,
    voucherOriginProof = null }) {
    scope(clinicId, actorId);
    if (!v.positiveId(patientId) || !v.positiveId(actorId) || !v.uuid(requestKey)) r.fail('birth_key_invalid');
    const origin = voucherOriginProof ? require('../lib/voucher-booking-origin').proofOrigin(voucherOriginProof, { transaction, db }) : null;
    if (origin && (origin.clinic_id !== clinicId || origin.patient_id !== patientId || origin.actor_id !== actorId
      || require('../lib/voucher-booking-origin').childRequestKey(origin) !== requestKey)) r.fail('scope_invalid');
    const hashPlan = candidate => origin
      ? r.voucherBirthRequestHash({ clinicId, patientId, plan: candidate, voucherOriginProof, transaction })
      : r.birthRequestHash({ clinicId, patientId, plan: candidate });
    const requestHash = hashPlan(plan);
    return transact(transaction, async tx => {
      const prior = await db.AppointmentVisitBirthRequest.findOne({ where: { clinic_id: clinicId, request_key: requestKey }, transaction: tx });
      // CLOSED rollout creates no placeholder/event/appointment. Replay of a
      // previously enrolled birth is identity only, never dispatch permission.
      if (!prior && rolloutEnabled() !== true) r.fail('rollout_closed');
      const [found] = prior ? [prior] : await db.AppointmentVisitBirthRequest.findOrCreate({
        where: { clinic_id: clinicId, request_key: requestKey }, transaction: tx, hooks: false,
        defaults: { id: newId(), patient_id: patientId, request_sha256: requestHash, actor_id: actorId, recorded_at: now() },
      });
      const request = await db.AppointmentVisitBirthRequest.findByPk(found.id, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (Number(request.patient_id) !== patientId || request.request_sha256 !== requestHash) r.fail('birth_request_conflict');
      if (request.appointment_id || request.visit_id) {
        // Voucher replay is the immutable aggregate receipt, never adoption or
        // reinterpretation of a child's current reservation after a mutation.
        if (origin) r.fail('voucher_parent_replay_required');
        if (!request.appointment_id || !request.visit_id) r.fail('birth_receipt_corrupt');
        const appointment = await db.CitaPaciente.findByPk(request.appointment_id, { transaction: tx, lock: tx.LOCK.UPDATE });
        const visit = await db.AppointmentVisit.findByPk(request.visit_id, { transaction: tx });
        if (!appointment || !visit || Number(appointment.clinica_id) !== clinicId || Number(appointment.paciente_id) !== patientId
          || Number(visit.clinic_id) !== clinicId || Number(visit.patient_id) !== patientId || visit.status !== 'active'
          || Number(visit.owner_appointment_id) !== Number(appointment.id_cita)
          || r.birthRequestHash({ clinicId, patientId, plan: planFor(appointment) }) !== requestHash) r.fail('birth_replay_changed');
        r.assertBirthEligibility(appointment, now());
        const identity = await foundation.ensureSingletonVisit({ appointmentId: Number(appointment.id_cita), clinicId, actorId, transaction: tx });
        if (identity.created || identity.visit.id !== visit.id || identity.visit.grouping_kind !== 'singleton') r.fail('birth_receipt_corrupt');
        const enrollment = r.assertStoredEnrollment(visit);
        if (enrollment.birth_request_key !== requestKey || enrollment.birth_request_sha256 !== requestHash) r.fail('birth_receipt_corrupt');
        return { created: false, appointment, visit, request };
      }
      if (rolloutEnabled() !== true || typeof bookCanonicalBirth !== 'function') r.fail('canonical_writer_unavailable');
      const compiled = r.compiledContract(token);
      if (compiled.clinic_id !== clinicId) r.fail('scope_invalid');
      await verifyGraphs(compiled, tx);
      let persisted = null, persistCalls = 0;
      const persist = async values => {
        if (++persistCalls !== 1 || values.id_cita != null || Number(values.clinica_id) !== clinicId || Number(values.paciente_id) !== patientId) r.fail('canonical_birth_invalid');
        r.assertBirthEligibility(values, now(), { voucherOriginProof, transaction: tx });
        if (hashPlan(planFor(values)) !== requestHash) r.fail('birth_plan_changed');
        persisted = await db.CitaPaciente.create(values, { transaction: tx });
        return persisted;
      };
      const appointment = await bookCanonicalBirth({ clinicId, patientId, actorId, plan: v.clone(plan), transaction: tx, persist });
      if (persistCalls !== 1 || appointment !== persisted || !persisted?.id_cita) r.fail('canonical_birth_proof_required');
      // Cita's native timestamp is DATE(0). Freeze its persisted value, not the
      // Sequelize pre-INSERT millisecond value (which can cross a local day).
      if (compiled.reminder_bindings !== undefined) await appointment.reload({ transaction: tx });
      const { visit } = await foundation.ensureSingletonVisit({ appointmentId: Number(appointment.id_cita), clinicId, actorId, transaction: tx });
      const enrollment = { ...compiled, birth_request_key: requestKey, birth_request_sha256: requestHash,
        enrolled_at: v.instant(request.recorded_at), actor_id: actorId, ...(origin ? { origin } : {}),
        ...(compiled.reminder_bindings !== undefined ? { reminder_booked_at: v.instant(appointment.created_at || appointment.createdAt) } : {}) };
      await visit.update({ runtime_enrollment: enrollment, runtime_enrollment_sha256: v.hash(enrollment) }, opts(tx));
      await request.update({ appointment_id: Number(appointment.id_cita), visit_id: visit.id }, opts(tx));
      return { created: true, appointment, visit, request };
    });
  }
  async function planVisitCommunication({ visitId, clinicId, expectedRevision, stageKey, templateVersionId,
    sourceCommunicationId = null, inboundMessageId = null, actorId = null, transaction = null }) {
    scope(clinicId, actorId);
    return transact(transaction, async tx => {
      const visit = await db.AppointmentVisit.findByPk(visitId, { transaction: tx });
      if (!visit || Number(visit.clinic_id) !== clinicId || Number(visit.communication_revision) !== expectedRevision) r.fail('revision_changed');
      const enrollment = r.assertStoredEnrollment(visit), definition = r.stageDefinition(enrollment, templateVersionId, stageKey);
      let sourceWait = null;
      if (definition.stage.source_key) {
        const source = await db.AppointmentVisitCommunication.findByPk(sourceCommunicationId, { transaction: tx });
        if (!source || source.visit_id !== visitId || !source.runtime_wait || v.hash(source.runtime_wait) !== source.runtime_wait_sha256
          || source.runtime_wait.stage_key !== definition.stage.source_key) r.fail('source_wait_required');
        sourceWait = v.object(source.runtime_wait);
        const initialExecution = await db.FlowExecutionV2.findByPk(sourceWait.execution_id, { transaction: tx });
        const execution = await assertExecutionActive(initialExecution, tx, { allowCompleted: true });
        if (definition.stage.policy === 'ack') {
          if (!db.AutomationInboundMessageClaim || !db.Message) r.fail('inbound_guard_unavailable');
          const claim = await db.AutomationInboundMessageClaim.findOne({ where: { message_id: inboundMessageId }, transaction: tx });
          const message = await db.Message.findByPk(inboundMessageId, { transaction: tx });
          const at = message?.sent_at && new Date(message.sent_at).getTime();
          if (!claim || claim.status !== 'completed' || claim.owner_type !== 'wait_response'
            || Number(claim.owner_reference_id) !== sourceWait.execution_id || Number(claim.clinic_id) !== clinicId
            || Number(claim.conversation_id) !== sourceWait.conversation_id || !message || message.direction !== 'inbound'
            || Number(message.conversation_id) !== sourceWait.conversation_id || v.qa(message)
            || !at || at < Date.parse(sourceWait.starts_at) || at >= Date.parse(sourceWait.cutoff_at)) r.fail('inbound_owner_invalid');
        } else {
          if (!execution || execution.status !== 'waiting' || execution.current_node_id !== sourceWait.wait_node_id
            || execution.waiting_meta?.pending_response_message_ids?.length || Date.parse(sourceWait.due_at) > new Date(now()).getTime()) r.fail('timeout_not_owned');
          if (!inboxHealth.state(readInboxHealth(), clinicId, new Date(now()).getTime()).readyForTimeout) r.fail('timeout_reception_held');
          // A fresh check of reception, native reply buffers and owned attempt
          // remains mandatory at execution/dispatch, not just this intent claim.
        }
      } else if (sourceCommunicationId || inboundMessageId) r.fail('stage_source_invalid');
      const mutation = Number(visit.communication_revision) > 1 && ['details', 'cancellation', 'attendance_day_before', 'attendance_same_day'].includes(stageKey)
        ? (await mutationEventFor(visit, tx)).proof : null;
      const sealed = r.sealStagePlan({ visit, templateVersionId, stageKey, sourceWait, mutation });
      return foundation.claimCommunication({ visitId, clinicId, expectedRevision, purpose: definition.stage.purpose,
        window: { key: sealed.window.key, starts_at: sealed.window.starts_at, ends_at: sealed.window.ends_at }, templateVersionId,
        actorId, transaction: tx, runtimeStagePlan: sealed.token });
    });
  }
  async function planReminderCommunications({ visit, actorId, registeredManifests = null, transaction, strict = false }) {
    const enrollment = r.assertStoredEnrollment(visit), planned = [], held = [];
    // Missing pin is old enrollment, not a licence to adopt current schedules.
    if (enrollment.reminder_bindings === undefined) return { planned: 0, held: ['visit_schedule_adapter_required'] };
    for (const selected of enrollment.reminder_bindings) {
      const definition = r.stageDefinition(enrollment, selected.template_version_id, selected.stage_key);
      if (registeredManifests && !registeredManifests.some(item => r.reviewedManifestMatches(definition.manifest, item, Number(visit.clinic_id)))) {
        held.push('visit_reminder_manifest_unavailable'); continue;
      }
      try {
        const result = await planVisitCommunication({ visitId: visit.id, clinicId: Number(visit.clinic_id), expectedRevision: Number(visit.communication_revision),
          stageKey: selected.stage_key, templateVersionId: selected.template_version_id, actorId, transaction });
        planned.push(result.communication.id);
      } catch (error) {
        if (error?.name?.startsWith('Sequelize') || error?.original?.code || !String(error.code || '').startsWith('appointment_visit_')) throw error;
        if (strict && !['appointment_visit_runtime_reminder_window_not_future', 'appointment_visit_runtime_reminder_booking_window_excluded'].includes(error.code)) throw error;
        held.push(error.code);
      }
    }
    return { planned: planned.length, communication_ids: planned, held };
  }
  async function freezePurposeWait({ sourceCommunicationId, clinicId, waitNodeId, transaction = null }) {
    scope(clinicId);
    return transact(transaction, async tx => {
      const initial = await db.AppointmentVisitCommunication.findByPk(sourceCommunicationId, { transaction: tx });
      if (!initial || Number(initial.clinic_id) !== clinicId || !initial.execution_id || !initial.message_id) r.fail('source_wait_required');
      const initialExecution = await db.FlowExecutionV2.findByPk(initial.execution_id, { transaction: tx });
      const execution = await assertExecutionActive(initialExecution, tx, { allowCompleted: true });
      const context = await foundation.inspectCommunicationCurrent({ communicationId: sourceCommunicationId, clinicId, transaction: tx });
      const source = context.communication;
      if (source.runtime_wait) {
        if (v.hash(source.runtime_wait) !== source.runtime_wait_sha256 || source.runtime_wait.wait_node_id !== waitNodeId) r.fail('wait_binding_changed');
        return { created: false, wait: source.runtime_wait };
      }
      const { stage } = r.assertStageExecution({ visit: context.visit, communication: source, execution });
      const policy = stage.waits.find(wait => wait.node_id === waitNodeId), meta = v.object(execution.waiting_meta);
      const output = v.object(v.object(execution.context).outputs?.[policy?.listens_to_node_id]);
      const message = context.message;
      if (!policy || execution.status !== 'waiting' || execution.current_node_id !== waitNodeId || meta.type !== 'delay/wait_response'
        || meta.listens_to_node_id !== policy.listens_to_node_id || Number(output.message_id) !== Number(message?.id)
        || Number(output.conversation_id) !== Number(message?.conversation_id) || v.messageOutcome(message) !== 'accepted' || !message.sent_at) r.fail('wait_owner_invalid');
      const starts = v.instant(meta.wait_starts_at), due = v.instant(execution.context?.outputs?.[waitNodeId]?.timeout_at || execution.wait_until);
      // Existing FlowExecution wait_until is DATE(0); its native JSON output
      // preserves ms. Do not change that model or invent an updated_at anchor.
      if (Date.parse(starts) < new Date(message.sent_at).getTime() || Date.parse(due) !== Date.parse(starts) + policy.duration_ms
        || Math.floor(new Date(execution.wait_until).getTime() / 1000) !== Math.floor(Date.parse(due) / 1000)) r.fail('wait_clock_invalid');
      const wait = { schema: 'appointment-visit-purpose-wait/1', visit_id: source.visit_id,
        communication_revision: Number(source.communication_revision), purpose: source.purpose, window_key: source.window_key,
        stage_key: source.runtime_stage.stage_key, source_communication_id: source.id, source_message_id: Number(message.id),
        execution_id: Number(execution.id), conversation_id: Number(message.conversation_id), wait_node_id: waitNodeId,
        listens_to_node_id: policy.listens_to_node_id, runtime_namespace: meta.runtime_namespace,
        starts_at: starts, due_at: due, cutoff_at: v.instant(new Date(Math.min(Date.parse(context.visit.snapshot.patient_start_at),
          new Date(source.window_ends_at).getTime()))) };
      if (typeof wait.runtime_namespace !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(wait.runtime_namespace)) r.fail('wait_owner_invalid');
      await source.update({ runtime_wait: wait, runtime_wait_sha256: v.hash(wait) }, opts(tx));
      return { created: true, wait };
    });
  }
  return Object.freeze({ createCanonicalBirth, prepareCanonicalMutation, persistCanonicalMutation, mutationEventFor, assertCommunicationMutation,
    planVisitCommunication, planReminderCommunications, freezePurposeWait });
}
module.exports = { createAppointmentVisitRuntimeService };
