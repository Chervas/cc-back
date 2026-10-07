'use strict';

const v = require('../lib/appointment-visit-communication');
const r = require('../lib/appointment-visit-runtime-contract');
const { createAppointmentVisitRuntimeService } = require('./appointmentVisitRuntime.service');
const { createAppointmentVisitCommunicationService } = require('./appointmentVisitCommunications.service');
const { createAppointmentVisitDispatchService, JOB_TYPE } = require('./appointmentVisitDispatch.service');
const { assertBookingPlanReceipt } = require('../lib/booking-plan-receipt');
const births = new WeakMap(), results = new WeakMap(), authorizations = new WeakMap(), mutationTokens = new WeakMap(), mutationResults = new WeakMap(), voucherBirths = new WeakMap();
const held = code => { throw Object.assign(Error(code), { code, retryable: false, preserveFlowState: true, statusCode: 409 }); };
const planFor = row => ({ start_at: row.inicio, end_at: row.fin, treatment_id: row.tratamiento_id, doctor_id: row.doctor_id,
  installation_id: row.instalacion_id, booking: v.object(row.import_metadata).booking,
  ...(v.object(row.import_metadata).additional_staff ? { additional_staff: v.object(row.import_metadata).additional_staff } : {}) });
function createAppointmentVisitManagedService({ db, now = () => new Date(),
  enabled = () => process.env.APPOINTMENT_VISIT_COMMUNICATIONS_V1_ENABLED === 'true',
  manifests = () => require('../config/appointmentVisitRuntimeManifests'),
  resolveBirthTemplate = (row) => require('./appointmentAutomationV2Runtime.service').resolveTemplateForCitaEvent(row, 'appointment_created'),
  resolveReminderTemplates = (row, options) => require('./appointmentAutomationV2Runtime.service').resolveScheduledTemplatesForCita(row, 'appointment_reminder_window', options),
  namespace = () => process.env.JOB_RUNTIME_NAMESPACE,
  foundation = null,
  notifyJob = id => require('./jobScheduler.service').triggerImmediate(id),
  enqueueUniqueJob = (values, transaction) => require('./jobRequests.service').enqueueUniqueJobRequest(values, { transaction }),
  whatsapp = () => require('./whatsapp.service'),
}) {
  const foundationFor = () => foundation || (foundation = createAppointmentVisitCommunicationService({ db, now }));
  const core = writer => createAppointmentVisitRuntimeService({ db, now, foundation: foundationFor(), rolloutEnabled: enabled, bookCanonicalBirth: writer });
  let voucherOrigins = null;
  const voucherReader = () => voucherOrigins || (voucherOrigins = require('../lib/voucher-booking-origin').createVoucherBookingOriginReader({ db }));
  const transact = work => db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, work);
  // Discovery progress is not delivery authority/history. A finite high-water
  // sweep revisits blocked receipts without allowing newly appended work to
  // postpone wrap forever. Restart begins another guarded sweep; no ledger or
  // window is rewritten. Concurrent ticks in this process share one page.
  let recoverySweeps = {}, recoveryInFlight = null;
  async function uninstalledClosed(read) {
    try { return await read(); }
    catch (error) {
      if (enabled() !== true && ['ER_NO_SUCH_TABLE','ER_BAD_FIELD_ERROR'].includes(error.original?.code)) return null;
      throw error;
    }
  }
  async function visitFor(appointmentId) {
    if (!db.AppointmentVisitMember || !db.AppointmentVisit) return null;
    return uninstalledClosed(async () => {
      const member = await db.AppointmentVisitMember.findByPk(appointmentId);
      return member && await db.AppointmentVisit.findByPk(member.visit_id);
    });
  }
  async function prepareBirth({ requestKey, values, clinic, actorId, profile }) {
    if (requestKey === undefined) return null;
    const receipt = v.uuid(requestKey) && await uninstalledClosed(() => db.AppointmentVisitBirthRequest.findOne({ where: { clinic_id: Number(values.clinica_id), request_key: requestKey } }));
    if (receipt) {
      const token = Object.freeze({ schema: 'appointment-visit-canonical-birth/1' });
      births.set(token, { owner: api, requestKey, actorId, clinic, contract: null }); return token;
    }
    if (enabled() !== true) return null;
    const metadata = v.object(values.import_metadata), suppress = v.object(metadata.notification_suppression || metadata.notificationSuppression);
    if (profile?.version !== 4 || profile.phases.length < 2 || values.source_system || values.source_reference || values.voucher_id
      || values.es_provisional || values.hold_expires_at || v.qa(values) || v.held(metadata) || metadata.historical_registration
      || metadata.program_session || metadata.clinical_component_parent || metadata.clinical_component_children
      || Object.values(suppress).some(value => value === true || value === 1 || value === 'true' || value === '1')) return null;
    const contract = await reviewedBirthContract({ values, clinic, actorId, requestKey });
    if (!contract) return null;
    const token = Object.freeze({ schema: 'appointment-visit-canonical-birth/1' });
    births.set(token, { owner: api, requestKey, actorId: Number(actorId), clinic, contract }); return token;
  }
  async function reviewedBirthContract({ values, clinic, actorId, requestKey }) {
    const configured = manifests();
    if (!Array.isArray(configured) || !configured.length) return null;
    const template = await resolveBirthTemplate(values);
    const reviewed = configured.find(item => item.clinic_id === Number(values.clinica_id)
      && item.template_version_id === Number(template?.id) && item.graph_sha256 === r.graphHash(template));
    if (!reviewed) return null; // Unsupported graph stays unenrolled legacy.
    if (!v.uuid(requestKey) || !v.positiveId(Number(actorId))) held('appointment_visit_runtime_birth_key_invalid');
    const runtimeNamespace = namespace();
    if (typeof runtimeNamespace !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(runtimeNamespace)) held('appointment_visit_runtime_birth_namespace_invalid');
    let contract;
    // Freeze every reviewed event graph at birth, not a later mutable catalogue
    // lookup on reschedule/cancel. Unsupported/unreviewed graphs cannot be
    // adopted into this visit after it has acquired communication history.
    const frozen = [];
    for (const item of configured.filter(item => item.clinic_id === Number(values.clinica_id))) {
      const candidate = Number(item.template_version_id) === Number(template.id) ? template
        : await db.AutomationFlowTemplateV2.findByPk(item.template_version_id);
      if (!candidate || candidate.is_active !== true || !candidate.published_at || r.graphHash(candidate) !== item.graph_sha256) continue;
      frozen.push({ template: candidate, stages: item.stages, mutations: item.mutations || [] });
    }
    // The registry is review evidence, NOT a selector. Freeze only the actual
    // existing selector's reminder slots; never send all reviewed graphs.
    const reminderBindings = [];
    try {
      const automation = require('./appointmentAutomationV2Runtime.service'), policy = require('../lib/appointment-visit-reminder-policy');
      for (const candidate of await resolveReminderTemplates(values)) {
        const current = v.plain(candidate), schedulePolicy = policy.policy(automation.getTemplateTriggerConfig(current));
        const stageKey = 'attendance_' + schedulePolicy.schedule_moment;
        const item = configured.find(item => item.clinic_id === Number(values.clinica_id)
          && item.template_version_id === Number(current.id) && item.graph_sha256 === r.graphHash(current)
          && item.stages.some(stage => stage.key === stageKey));
        if (!item) return null; // Full reminder coverage not reviewed: legacy, no partial adoption.
        const selected = policy.binding({ templateVersionId: Number(current.id), stageKey, schedulePolicy,
          fireGraceMs: automation.scheduledTriggerFireGraceMs() });
        policy.scheduledBounds(selected, values.inicio, require('../lib/availability-calendar').resolveClinicTimezone(clinic));
        reminderBindings.push(selected);
      }
      policy.normalizeBindings(reminderBindings);
    } catch (error) { if (String(error.code || '').startsWith('appointment_visit_')) return null; throw error; }
    try { contract = r.compileEnrollmentContract({ clinicId: Number(values.clinica_id), groupId: Number(clinic.grupoClinicaId) || null,
      runtimeNamespace,
      timeZone: require('../lib/availability-calendar').resolveClinicTimezone(clinic), manifests: frozen, reminderBindings }); }
    catch (error) { if (error.code?.startsWith('appointment_visit_runtime_')) return null; throw error; }
    return contract;
  }
  async function prepareVoucherBirth({ values, clinic, actorId, profile, parentRequestKey, parentRequestSha256,
    sequence, slotPlanSha256, transaction }) {
    // Never adopt an existing/imported appointment. The old voucher purchase
    // may have any legitimate source; this proof covers this NEW native booking.
    if (enabled() !== true || profile?.version !== 4 || !profile.phases?.length) return null;
    const metadata = v.object(values.import_metadata), suppress = v.object(metadata.notification_suppression || metadata.notificationSuppression);
    if (!v.positiveId(Number(values.voucher_id)) || values.id_cita != null || values.source_system || values.source_reference
      || values.es_provisional || values.hold_expires_at || v.qa(values) || v.held(metadata) || metadata.historical_registration
      || metadata.program_session || metadata.clinical_component_parent || metadata.clinical_component_children
      || Object.values(suppress).some(value => value === true || value === 1 || value === 'true' || value === '1')) return null;
    const contract = await reviewedBirthContract({ values, clinic, actorId, requestKey: parentRequestKey });
    if (!contract) return null;
    const proof = await voucherReader().prepare({ voucherId: Number(values.voucher_id), parentRequestKey, parentRequestSha256,
      actorId: Number(actorId), sequence, slotPlanSha256, transaction });
    const origin = voucherReader().ownProof(proof, transaction);
    const token = Object.freeze({ schema: 'appointment-visit-canonical-birth/1' });
    births.set(token, { owner: api, requestKey: require('../lib/voucher-booking-origin').childRequestKey(origin),
      actorId: Number(actorId), clinic, contract, voucherOriginProof: proof, transaction }); return token;
  }
  function birthFor(token) {
    const value = births.get(token); if (!value || value.owner !== api) held('appointment_visit_runtime_server_birth_required'); return value;
  }
  async function replayBirth(token, { values, selections, durationSelection, additionalStaffIds, expectedPlanSha256, transaction }) {
    const birth = birthFor(token), clinicId = Number(values.clinica_id), patientId = Number(values.paciente_id);
    if (birth.voucherOriginProof && (birth.transaction !== transaction || transaction?.finished)) held('appointment_visit_runtime_server_birth_required');
    const receipt = await db.AppointmentVisitBirthRequest.findOne({ where: { clinic_id: clinicId, request_key: birth.requestKey }, transaction });
    if (!receipt) return null;
    if (birth.voucherOriginProof) held('appointment_visit_runtime_voucher_parent_replay_required');
    const row = await db.CitaPaciente.findByPk(receipt.appointment_id, { transaction });
    if (!row || Number(receipt.patient_id) !== patientId) held('appointment_visit_runtime_birth_request_conflict');
    const booking = v.object(row.import_metadata).booking, phases = booking?.phases || [];
    if (v.instant(values.inicio) !== v.instant(row.inicio) || values.fin != null && v.instant(values.fin) !== v.instant(row.fin)
      || Number(values.tratamiento_id) !== Number(row.tratamiento_id)) held('appointment_visit_runtime_birth_request_conflict');
    for (const [key, selection] of Object.entries(selections || {})) {
      const phase = phases.find(item => item.key === key);
      if (!phase || Object.keys(selection || {}).some(key => !['doctor_id', 'installation_id', 'equipment_ids'].includes(key))
        || selection.doctor_id != null && !phase.doctor_ids.includes(Number(selection.doctor_id))
        || selection.installation_id != null && Number(selection.installation_id) !== Number(phase.installation_id)
        || selection.equipment_ids && v.canonical(selection.equipment_ids.map(Number).sort((a,b) => a-b))
          !== v.canonical((phase.equipment || []).map(row => Number(row.id)).sort((a,b) => a-b))) held('appointment_visit_runtime_birth_request_conflict');
    }
    if (durationSelection !== undefined) {
      const selection = require('../lib/booking-profile-duration').normalizeDurationSelection(durationSelection), recorded = booking.duration_selection;
      if (!recorded || selection.duration_minutes != null && selection.duration_minutes !== recorded.duration_minutes
        || selection.phase_durations && v.canonical(selection.phase_durations) !== v.canonical(recorded.phase_durations)) held('appointment_visit_runtime_birth_request_conflict');
    }
    if (additionalStaffIds !== undefined && v.canonical(additionalStaffIds) !== v.canonical(v.object(row.import_metadata).additional_staff?.ids || [])) held('appointment_visit_runtime_birth_request_conflict');
    assertBookingPlanReceipt(expectedPlanSha256, booking.profile, { start_at: row.inicio, end_at: row.fin, phases,
      capacity_fully_verified: booking.capacity_fully_verified, attention_requirements_pending: booking.attention_requirements_pending,
      warnings: booking.warnings,
      requires_priority_acknowledgement: (booking.warnings || []).some(item => item.code === 'NON_PREFERRED_PROFESSIONAL'),
      requires_overlap_acknowledgement: booking.overlap_confirmed === true });
    const result = await core(null).createCanonicalBirth({ clinicId, patientId, actorId: birth.actorId, requestKey: birth.requestKey,
      plan: planFor(row), transaction, contract: birth.contract });
    results.set(result.appointment, result); return result.appointment;
  }
  async function persistBirth(token, { values, transaction, afterPersist }) {
    const birth = birthFor(token);
    if (!birth.contract) held('appointment_visit_runtime_birth_receipt_missing');
    if (birth.voucherOriginProof && (birth.transaction !== transaction || transaction?.finished)) held('appointment_visit_runtime_server_birth_required');
    const result = await core(({ persist }) => persist(values)).createCanonicalBirth({ clinicId: Number(values.clinica_id),
      patientId: Number(values.paciente_id), actorId: birth.actorId, requestKey: birth.requestKey, plan: planFor(values), contract: birth.contract, transaction,
      ...(birth.voucherOriginProof ? { voucherOriginProof: birth.voucherOriginProof } : {}) });
    if (result.created && afterPersist) await afterPersist(result.appointment, transaction);
    if (birth.voucherOriginProof) {
      // Parent receipt does not exist until all batch slots have succeeded.
      // Defer ONLY this origin's initial intent until that receipt is present,
      // still in the same outer transaction as all appointments/occupancy.
      voucherBirths.set(result.appointment, { owner: api, result, transaction });
      results.set(result.appointment, result); return result.appointment;
    }
    await planInitialDetails(result, birth.actorId, transaction);
    results.set(result.appointment, result); return result.appointment;
  }
  async function planInitialDetails(result, actorId, transaction) {
    const enrollment = r.assertStoredEnrollment(result.visit), manifest = enrollment.manifests.find(item => item.trigger_type === 'appointment_created' && item.stages.some(stage => stage.key === 'details'));
    if (!manifest) held('appointment_visit_runtime_details_manifest_required');
    await core(null).planVisitCommunication({ visitId: result.visit.id, clinicId: Number(result.appointment.clinica_id), expectedRevision: 1,
      stageKey: 'details', templateVersionId: manifest.template_version_id, actorId, transaction });
    await core(null).planReminderCommunications({ visit: result.visit, actorId, transaction, registeredManifests: manifests(), strict: true });
  }
  async function finalizeVoucherBirths({ appointments, transaction }) {
    let finalized = 0;
    for (const appointment of appointments) {
      const born = voucherBirths.get(appointment);
      if (!born) continue;
      if (born.owner !== api || born.transaction !== transaction || transaction?.finished) held('appointment_visit_runtime_server_birth_required');
      await voucherReader().forVisit({ visit: born.result.visit, appointment, transaction });
      await planInitialDetails(born.result, r.assertStoredEnrollment(born.result.visit).actor_id, transaction);
      finalized++;
    }
    return { finalized };
  }
  async function managedVisit(row) { const visit = await visitFor(Number(row?.id_cita)); return visit?.runtime_enrollment ? visit : null; }
  function birthResult(row) { return results.get(row) || null; }
  async function prepareMutation(args) {
    const runtime = core(null), proof = await uninstalledClosed(() => runtime.prepareCanonicalMutation(args));
    if (!proof) return null;
    const token = Object.freeze({ schema: 'appointment-visit-canonical-mutation/1' });
    mutationTokens.set(token, { owner: api, runtime, proof }); return token;
  }
  async function persistMutation(token, args) {
    const proof = mutationTokens.get(token);
    if (!proof || proof.owner !== api) held('appointment_visit_runtime_server_mutation_proof_required');
    const result = await proof.runtime.persistCanonicalMutation(proof.proof, { ...args, communicationEnabled: enabled() === true,
      registeredManifests: manifests() });
    mutationResults.set(args.appointment, result); return result;
  }
  function mutationResult(row) { return mutationResults.get(row) || null; }
  function assertReviewedStage(visit, communication) {
    const enrollment = r.assertStoredEnrollment(visit), definition = r.stageDefinition(enrollment, Number(communication.template_version_id), communication.runtime_stage?.stage_key);
    if (!v.positiveId(Number(communication.created_by))
      || Number(communication.communication_revision) === 1 && ['appointment_details', 'reminder_day_before', 'reminder_same_day'].includes(communication.purpose)
        && Number(communication.created_by) !== enrollment.actor_id) held('appointment_visit_runtime_stage_actor_invalid');
    if (enrollment.runtime_namespace !== namespace() || !Array.isArray(manifests())
      || !manifests().some(item => r.reviewedManifestMatches(definition.manifest, item, Number(visit.clinic_id)))) held('appointment_visit_runtime_manifest_unavailable');
  }
  async function assertMutationNode(execution, node, { transaction, appointmentId, clinicId } = {}) {
    if (!transaction || transaction.options?.isolationLevel !== 'READ COMMITTED' || transaction.finished) held('appointment_visit_runtime_mutation_transaction_required');
    // The FlowEngine caller owns Cita/member/visit, then family/execution/job.
    // Read the locked native execution again, not a client/context actor field.
    const active = await db.FlowExecutionV2.findByPk(execution.id, { transaction, lock: transaction.LOCK.UPDATE });
    const binding = v.object(active?.context?.appointment_visit);
    if (!binding.visit_id) {
      // The execution must not lose an existing managed binding. Only a
      // genuinely unenrolled legacy appointment may retain the legacy lane
      // when the additive managed schema has never been installed.
      if (v.object(execution?.context?.appointment_visit).visit_id) held('appointment_visit_runtime_mutation_binding_required');
      const visit = await uninstalledClosed(async () => {
        const member = v.positiveId(Number(appointmentId)) && db.AppointmentVisitMember
          && await db.AppointmentVisitMember.findByPk(Number(appointmentId), { transaction });
        return member && await db.AppointmentVisit.findByPk(member.visit_id, { transaction });
      });
      if (visit?.runtime_enrollment) held('appointment_visit_runtime_mutation_binding_required');
      return null; // A genuinely unenrolled legacy appointment retains its lane.
    }
    if (enabled() !== true) held('appointment_visit_runtime_rollout_closed');
    if (!active || active.status !== 'running' || active.current_node_id !== node?.id
      || Number(active.created_by) !== Number(execution.created_by) || !v.positiveId(Number(active.created_by))) held('appointment_visit_runtime_mutation_execution_changed');
    if (appointmentId != null && Number(active.trigger_entity_id) !== Number(appointmentId)
      || clinicId != null && Number(active.clinic_id) !== Number(clinicId)) held('appointment_visit_runtime_execution_scope_changed');
    const context = await foundationFor().inspectCommunicationCurrent({ communicationId: binding.communication_id,
      clinicId: Number(active.clinic_id), transaction });
    assertReviewedStage(context.visit, context.communication);
    await core(null).assertCommunicationMutation({ ...context, transaction });
    const { manifest } = r.assertStageExecution({ visit: context.visit, communication: context.communication, execution: active });
    if (Number(context.communication.execution_id) !== Number(active.id)
      || Number(context.communication.created_by) !== Number(active.created_by)
      || appointmentId != null && Number(context.visit.owner_appointment_id) !== Number(appointmentId)
      || clinicId != null && Number(context.visit.clinic_id) !== Number(clinicId)) held('appointment_visit_runtime_mutation_execution_changed');
    const template = await db.AutomationFlowTemplateV2.findByPk(active.template_version_id, { transaction });
    const mutation = manifest.mutations.find(item => item.node_id === node.id);
    const recordedNode = template?.nodes?.find(item => item.id === node.id);
    if (!template || template.is_active !== true || !template.published_at || r.graphHash(template) !== manifest.graph_sha256 || !mutation
      || recordedNode?.type !== 'action/change_status' || recordedNode.config?.target_entity !== 'appointment'
      || recordedNode.config?.new_status !== mutation.new_status || node.type !== recordedNode.type
      || node.config?.target_entity !== 'appointment' || node.config?.new_status !== mutation.new_status) held('appointment_visit_runtime_mutation_node_unapproved');
    return { actorId: Number(active.created_by), mutation };
  }
  async function publishCita(cita, options, buildContext) {
    const visit = await managedVisit(cita); if (!visit) return null;
    if (enabled() !== true) return { success: true, skipped: true, managed: true, reason: 'visit_rollout_closed' };
    const revision = Number(visit.communication_revision), event = options.event_name || (revision === 1 ? 'appointment_created'
      : String(cita.estado) === 'cancelada' ? 'appointment_cancelled' : 'appointment_rescheduled');
    const reminder = event === 'appointment_reminder_window';
    const purpose = event === 'appointment_cancelled' ? 'cancellation'
      : ['appointment_created','appointment_rescheduled'].includes(event) ? 'appointment_details' : null;
    if ((!purpose && !reminder) || revision === 1 && event !== 'appointment_created' && !reminder) return { success: true, skipped: true, managed: true, reason: 'visit_mutation_adapter_required' };
    if (reminder && !v.uuid(options.visit_communication_id)) return { success: true, skipped: true, managed: true, reason: 'visit_reminder_intent_required' };
    const intent = await db.AppointmentVisitCommunication.findOne({ where: reminder
      ? { id: options.visit_communication_id, visit_id: visit.id, communication_revision: revision,
        purpose: { [require('sequelize').Op.in]: ['reminder_day_before', 'reminder_same_day'] } }
      : { visit_id: visit.id, purpose, communication_revision: revision, window_key: purpose === 'cancellation' ? 'cancellation' : 'details' } });
    if (!intent) {
      if (reminder) held('appointment_visit_runtime_reminder_intent_missing');
      if (revision === 1) held('appointment_visit_runtime_birth_intent_missing');
      return { success: true, skipped: true, managed: true, reason: mutationResult(cita)?.communication_held || 'visit_mutation_adapter_required' };
    }
    if (['accepted','unknown','cancelled'].includes(intent.status)) return { success: true, skipped: true, managed: true, reason: intent.status };
    if (reminder && +now() < +new Date(intent.window_starts_at)) return { success: true, skipped: true, managed: true, reason: 'visit_reminder_not_due' };
    assertReviewedStage(visit, intent);
    let execution, job;
    await transact(async transaction => {
      await core(null).assertCommunicationMutation({ visit, communication: intent, transaction });
      const template = await db.AutomationFlowTemplateV2.findByPk(intent.template_version_id, { transaction });
      if (template?.trigger_type !== event) held('appointment_visit_runtime_stage_trigger_invalid');
      await require('../lib/automation-runtime-stop').assertTemplateActive(template, transaction);
      execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: 'visit-stage:' + intent.id }, transaction, lock: transaction.LOCK.UPDATE });
      if (!execution) {
        const context = await buildContext(cita, template, options);
        context.appointment_visit = { visit_id: visit.id, communication_revision: revision, enrollment_sha256: visit.runtime_enrollment_sha256,
          communication_id: intent.id, stage_key: intent.runtime_stage.stage_key };
        execution = await db.FlowExecutionV2.create({ idempotency_key: 'visit-stage:' + intent.id, template_version_id: template.id, engine_version: 'v2', status: 'running',
          context, current_node_id: template.entry_node_id, trigger_type: template.trigger_type, trigger_entity_type: 'appointment',
          trigger_entity_id: visit.owner_appointment_id, clinic_id: visit.clinic_id, group_id: template.group_id, created_by: intent.created_by }, { transaction });
      }
      ({ job } = await enqueueUniqueJob({ type: 'automations_v2_execute', priority: 'critical', origin: 'appointment_visit_v1',
        payload: { execution_id: execution.id, __runtime_namespace: namespace() }, dedupeScope: 'flow_execution:' + execution.id }, transaction));
      await foundationFor().bindExecution({ communicationId: intent.id, clinicId: Number(visit.clinic_id), executionId: execution.id, transaction });
    });
    await notifyJob(job.id);
    return { success: true, managed: true, execution, queue_job_id: job.id };
  }
  async function syncReminderIntents(cita) {
    const visit = await managedVisit(cita); if (!visit) return null;
    if (enabled() !== true) return { success: true, managed: true, skipped: true, reason: 'visit_rollout_closed', scheduled_jobs: [], cancelled_jobs: [] };
    const enrollment = r.assertStoredEnrollment(visit);
    if (enrollment.reminder_bindings === undefined) return { success: true, managed: true, skipped: true,
      reason: 'visit_schedule_adapter_required', scheduled_jobs: [], cancelled_jobs: [] };
    const intents = await db.AppointmentVisitCommunication.findAll({ where: { visit_id: visit.id, communication_revision: Number(visit.communication_revision),
      purpose: { [require('sequelize').Op.in]: ['reminder_day_before', 'reminder_same_day'] } } });
    // Synchronization observes already committed intentions. The scheduler owns
    // publication; this must not manufacture intents on a replay or legacy row.
    return { success: true, managed: true, scheduled_jobs: [], cancelled_jobs: [], reminder_intents: intents.map(row => ({ id: row.id,
      purpose: row.purpose, scheduled_for: v.instant(row.window_starts_at), status: row.status })) };
  }
  async function reconcilePendingBirthIntents({ runtimeNamespace, limit = 25 } = {}) {
    // The existing scheduler tick is the discovery owner. CLOSED/default or
    // unsupported manifests perform no SQL and cannot adopt historical rows.
    if (enabled() !== true || !Array.isArray(manifests()) || !manifests().length) return { skipped: true, reason: 'visit_rollout_closed', examined: 0 };
    if (runtimeNamespace !== namespace() || typeof runtimeNamespace !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(runtimeNamespace)
      || !Number.isInteger(limit) || limit < 1 || limit > 100) held('appointment_visit_runtime_recovery_scope_invalid');
    if (recoveryInFlight) return recoveryInFlight;
    recoveryInFlight = discoverPage(runtimeNamespace, limit);
    try { return await recoveryInFlight; } finally { recoveryInFlight = null; }
  }
  async function discoverPage(runtimeNamespace, limit) {
    // A backlog of held birth/details events cannot consume the short reminder
    // grace budget. Each lane gets one bounded page on the SAME scheduler tick
    // and uses the SAME publisher/job/dispatch; this is not another queue.
    const reminders = await discoverKindPage(runtimeNamespace, limit, true);
    const events = await discoverKindPage(runtimeNamespace, limit, false);
    return { examined: reminders.examined + events.examined, published: reminders.published + events.published,
      held: reminders.held + events.held, sweep_completed: reminders.sweep_completed && events.sweep_completed };
  }
  async function discoverKindPage(runtimeNamespace, limit, reminderLane) {
    const { Op } = require('sequelize');
    const base = { ...(reminderLane
      ? { purpose: { [Op.in]: ['reminder_day_before', 'reminder_same_day'] }, window_starts_at: { [Op.lte]: now() }, window_ends_at: { [Op.gt]: now() } }
      : { [Op.or]: [{ purpose: 'appointment_details', window_key: 'details' }, { purpose: 'cancellation', window_key: 'cancellation' }] }),
      status: 'pending', execution_id: null, message_id: null };
    const include = [{ model: db.AppointmentVisit, as: 'visit', required: true, where: { status: 'active', grouping_kind: 'singleton',
      runtime_enrollment: { runtime_namespace: runtimeNamespace } } }];
    const point = intent => ({ at: new Date(intent.created_at), id: intent.id });
    const lane = reminderLane ? 'reminders' : 'events';
    if (recoverySweeps[lane] && recoverySweeps[lane].namespace !== runtimeNamespace) delete recoverySweeps[lane];
    if (!recoverySweeps[lane]) {
      const last = await db.AppointmentVisitCommunication.findOne({ where: base, include,
        order: [['created_at', 'DESC'], ['id', 'DESC']] });
      if (!last) return { examined: 0, published: 0, held: 0, sweep_completed: true };
      recoverySweeps[lane] = { namespace: runtimeNamespace, through: point(last), after: null };
    }
    const sweep = recoverySweeps[lane], bounds = [{ [Op.or]: [{ created_at: { [Op.lt]: sweep.through.at } },
      { created_at: sweep.through.at, id: { [Op.lte]: sweep.through.id } }] }];
    if (sweep.after) bounds.push({ [Op.or]: [{ created_at: { [Op.gt]: sweep.after.at } },
      { created_at: sweep.after.at, id: { [Op.gt]: sweep.after.id } }] });
    const candidates = await db.AppointmentVisitCommunication.findAll({ where: { ...base, [Op.and]: bounds }, include,
      order: [['created_at', 'ASC'], ['id', 'ASC']], limit });
    // Advance even over held/expired candidates or a later transient publication
    // failure. They remain immutable and are reconsidered next finite sweep.
    if (candidates.length) sweep.after = point(candidates[candidates.length - 1]);
    const complete = candidates.length < limit || sweep.after?.id === sweep.through.id;
    if (complete) delete recoverySweeps[lane];
    const outcome = { examined: candidates.length, published: 0, held: 0, sweep_completed: complete };
    for (const intent of candidates) {
      try {
        const visit = intent.visit, enrollment = r.assertStoredEnrollment(visit);
        const definition = r.stageDefinition(enrollment, intent.template_version_id, intent.runtime_stage?.stage_key);
        if (Number(visit.communication_revision) !== Number(intent.communication_revision)) { outcome.held++; continue; }
        if (enrollment.runtime_namespace !== runtimeNamespace || !manifests().some(item => r.reviewedManifestMatches(definition.manifest, item, Number(visit.clinic_id)))) {
          outcome.held++; continue;
        }
        const row = await db.CitaPaciente.findByPk(intent.owner_appointment_id);
        const result = await require('./appointmentAutomationV2Runtime.service').enqueueExecutionForCita(row,
          { event_name: definition.manifest.trigger_type, user_id: Number(intent.created_by),
            ...(['reminder_day_before', 'reminder_same_day'].includes(intent.purpose) ? { visit_communication_id: intent.id } : {}) });
        if (result?.managed && !result.skipped) outcome.published++; else outcome.held++;
      } catch (error) {
        // Keep the durable receipt for later guarded discovery. An expired,
        // stopped/HOLD/QA/revision-changed row never obtains a fresh window.
        if (error?.name?.startsWith('Sequelize') || error?.original?.code) throw error;
        outcome.held++;
      }
    }
    return outcome;
  }
  async function sendContext(execution, node, jobClaim = null) {
    const binding = v.object(execution?.context?.appointment_visit); if (!binding.visit_id) return null;
    if (enabled() !== true) held('appointment_visit_runtime_rollout_closed');
    const context = await transact(async transaction => {
      const active = await require('../lib/automation-runtime-stop').assertExecutionActive(execution, transaction, { allowCompleted: true });
      if (!require('./jobClaim.service').isJobClaim(jobClaim)) held('appointment_visit_runtime_execution_claim_required');
      await jobClaim.assert({ transaction, executionId: active.id });
      const inspected = await foundationFor().inspectCommunicationCurrent({ communicationId: binding.communication_id, clinicId: Number(execution.clinic_id), transaction });
      assertReviewedStage(inspected.visit, inspected.communication);
      await core(null).assertCommunicationMutation({ ...inspected, transaction }); return inspected;
    });
    r.assertStageExecution({ visit: context.visit, communication: context.communication, execution });
    if (!context.communication.runtime_stage.node_ids.includes(node.id)) held('appointment_visit_runtime_stage_consumer_unwired');
    return { ...context, delivery_key: v.deliveryKey(context.communication) };
  }
  async function enqueueMessage(message, execution, node, scheduledFor = null, jobClaim = null) {
    const context = await sendContext(execution, node, jobClaim); if (!context) held('appointment_visit_runtime_stage_binding_required');
    let job;
    await transact(async transaction => {
      await require('../lib/automation-runtime-stop').assertExecutionActive(execution, transaction, { allowCompleted: true });
      await jobClaim.assert({ transaction, executionId: execution.id });
      ({ job } = await enqueueUniqueJob({ type: JOB_TYPE, priority: 'critical', origin: 'appointment_visit_v1',
        payload: { visit_communication_id: context.communication.id, message_id: message.id, execution_id: execution.id, __runtime_namespace: namespace() },
        nextRunAt: scheduledFor, dedupeScope: 'visit-communication:' + context.communication.id }, transaction));
      await foundationFor().bindCommunication({ communicationId: context.communication.id, clinicId: Number(execution.clinic_id), executionId: execution.id, messageId: message.id, transaction });
    });
    if (!scheduledFor || +new Date(scheduledFor) <= +now()) await notifyJob(job.id);
    return { job, communication: context.communication };
  }
  async function reuseMessage(message, execution, node, jobClaim = null) {
    const context = await sendContext(execution, node, jobClaim); if (!context || message.automation_delivery_key !== context.delivery_key) held('appointment_visit_runtime_message_binding_changed');
    const outcome = v.messageOutcome(message);
    if (outcome === 'accepted') {
      // Provider acceptance reserves this intent forever, but is not a factual
      // send clock. In particular Meta may hold an accepted template for quality
      // assessment. Wait for the existing status webhook to persist sent_at;
      // never enqueue another transport or start response timers from createdAt.
      if (!message.sent_at) return deliveryWaiting(message, context.communication);
      return { kind: 'success', output: { status: message.status, message_id: message.id, conversation_id: message.conversation_id,
        effective_send_at: v.instant(message.sent_at), visit_communication_id: context.communication.id }, next_node_id: node.outputs?.on_success || null };
    }
    if (outcome === 'unknown') held('appointment_visit_runtime_delivery_unknown');
    await enqueueMessage(message, execution, node, message.metadata?.scheduled_for || null, jobClaim);
    return deliveryWaiting(message, context.communication);
  }
  function deliveryWaiting(message, communication) {
    return { kind: 'waiting', output: { status: 'visit_delivery_pending', message_id: message.id, conversation_id: message.conversation_id,
      visit_communication_id: communication.id }, waiting_meta: { type: 'appointment_visit_dispatch', resume_mode: 'retry_current_node',
      visit_communication_id: communication.id, source_message_id: message.id }, wait_until: null };
  }
  async function runDispatch(payload, job, jobClaim) {
    if (job.type !== JOB_TYPE || job.payload?.visit_communication_id !== payload.visit_communication_id) held('appointment_visit_runtime_dispatch_job_invalid');
    const service = createAppointmentVisitDispatchService({ db, now, foundation: foundationFor(), namespace, rolloutEnabled: enabled,
      preDispatchCheck: async (context, { transaction }) => {
        assertReviewedStage(context.visit, context.communication);
        await core(null).assertCommunicationMutation({ ...context, transaction });
        await require('../lib/automation-runtime-stop').assertMessageCanDispatch(context.message.id);
        await require('../lib/whatsappAppointmentEligibility').assertAutomatedMessageEligibility({ message: context.message, conversation: context.conversation,
          loadExecution: id => db.FlowExecutionV2.findByPk(id), loadAppointment: id => db.CitaPaciente.findByPk(id),
          patientHeld: id => require('../lib/whatsappAppointmentEligibility').patientImportHeld(id, db) });
        require('../lib/whatsappAuthorizedBrokerClient').assertMessageEligible(context.message);
        const scheduled = context.message.metadata?.scheduled_for;
        if (scheduled && +new Date(scheduled) > +now()) held('appointment_visit_runtime_dispatch_not_due');
      } });
    const claim = service.captureJobClaim({ job, jobClaim });
    const begun = await service.beginDispatch({ communicationId: payload.visit_communication_id, clinicId: Number((await db.FlowExecutionV2.findByPk(payload.execution_id))?.clinic_id), claim });
    if (!begun.begun && !begun.reused) return { status: 'completed', result: { skipped: true, reason: begun.reason } };
    const args = { dispatchId: begun.dispatch.id, clinicId: Number(begun.communication.clinic_id), attemptToken: begun.dispatch.attempt_token, claim };
    const preflight = await service.prepareDispatch(args); if (!preflight.allowed) return { status: 'failed', retryable: true, error_message: preflight.reason };
    const message = preflight.message, metadata = v.object(message.metadata);
    const authorization = Object.freeze({ schema: 'appointment-visit-transport/1' });
    authorizations.set(authorization, { owner: api, messageId: Number(message.id), service, args });
    try {
      const clinicConfig = metadata.sender_origin_id
        ? await whatsapp().getConfigByAssetId(metadata.sender_origin_id, { clinicId: args.clinicId })
        : await whatsapp().getClinicConfig(args.clinicId);
      // Existing common sender and authorized broker perform their final scope,
      // recipient/template/opt-out/HOLD/synthetic/contact/account gates again.
      const response = await whatsapp().sendMessage({ to: metadata.recipient, body: message.content, useTemplate: message.message_type === 'template',
        templateName: metadata.template_name, templateLanguage: metadata.template_language, templateParams: metadata.template_params,
        templateComponents: metadata.template_components, clinicConfig, healthContext: { source: 'appointment_visit_dispatch', messageId: message.id, jobId: job.id,
          visitDispatchAuthorization: authorization } });
      // Atomic receipt merge over the CURRENT SQL row. A webhook can persist
      // sent/delivered/read between transport and this write; never clear its
      // factual clock, regress its state, or replace concurrently added metadata.
      // Only our still-sending lease changes to pending provider acceptance.
      const observed = now(), receipt = { wa_response: response, wamid: response?.messages?.[0]?.id || null,
        provider_acceptance_status: response?.messages?.[0]?.message_status || 'accepted', provider_acceptance_at: v.instant(observed) };
      await db.sequelize.query("UPDATE `Messages` SET `status` = CASE WHEN `status` = 'sending' THEN 'pending' ELSE `status` END, "
        + "`metadata` = JSON_MERGE_PATCH(COALESCE(`metadata`, JSON_OBJECT()), CAST(:receipt AS JSON)), `updatedAt` = :observed "
        + "WHERE `id` = :id AND `direction` = 'outbound' AND `automation_delivery_key` = :deliveryKey", {
        replacements: { receipt: JSON.stringify(receipt), observed, id: Number(message.id), deliveryKey: v.deliveryKey(begun.communication) } });
      await message.reload();
    } catch (error) {
      const attempt = await db.AppointmentVisitDispatch.findByPk(begun.dispatch.id);
      // The common sender and broker may deny before any transport begins.
      // Only the broker's private proof boundary can mark network_started_at.
      if (!attempt.network_started_at) {
        await message.reload();
        if (v.messageOutcome(message) === 'accepted') {
          const settled = await service.reconcileDispatch({ dispatchId: begun.dispatch.id, clinicId: args.clinicId });
          return { status: 'completed', result: { communication_id: begun.communication.id, message_id: message.id, outcome: settled.status } };
        }
        if (attempt.status === 'pre_dispatch_failed') return { status: 'failed', retryable: error.retryable !== false, error, error_message: attempt.failure_reason };
        if (attempt.status === 'cancelled') return { status: 'completed', result: { skipped: true, reason: 'cancelled' } };
        await service.failBeforeNetwork(args, error);
        return { status: 'failed', retryable: error.retryable !== false, error, error_message: error.code || 'pre_dispatch_validation_failed' };
      }
      // A webhook may win after the network error. Atomically mark uncertainty
      // only while the CURRENT exact lease-bound Message has no factual receipt.
      // Never write a stale instance's metadata/state or clear any send clock.
      await db.sequelize.query("UPDATE `Messages` SET `status` = 'failed', "
        + "`metadata` = JSON_MERGE_PATCH(COALESCE(`metadata`, JSON_OBJECT()), CAST(:unknown AS JSON)), `updatedAt` = :observed "
        + "WHERE `id` = :id AND `direction` = 'outbound' AND `automation_delivery_key` = :deliveryKey "
        + "AND `sent_at` IS NULL AND `status` NOT IN ('sent', 'delivered', 'read') "
        + "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.wamid')), '') IN ('', 'null') "
        + "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.provider_acceptance_at')), '') IN ('', 'null') "
        + "AND JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.visit_dispatch_token')) = :token", {
        replacements: { unknown: JSON.stringify({ delivery_unknown: true }), observed: now(), id: Number(message.id),
          deliveryKey: v.deliveryKey(begun.communication), token: begun.dispatch.attempt_token } });
    }
    const settled = await service.reconcileDispatch({ dispatchId: begun.dispatch.id, clinicId: args.clinicId });
    return { status: 'completed', result: { communication_id: begun.communication.id, message_id: message.id, outcome: settled.status } };
  }
  async function assertTransport(messageId, authorization) {
    const proof = authorizations.get(authorization);
    if (!proof || proof.owner !== api || proof.messageId !== Number(messageId)) held('appointment_visit_runtime_transport_claim_required');
    await proof.service.assertDispatchAttemptCurrent(proof.args);
  }
  async function beginTransport(messageId, authorization) {
    const proof = authorizations.get(authorization);
    if (!proof || proof.owner !== api || proof.messageId !== Number(messageId)) held('appointment_visit_runtime_transport_claim_required');
    const result = await proof.service.runPreDispatchCheck(proof.args);
    if (!result.allowed) held(result.reason);
  }
  const api = Object.freeze({ prepareBirth, prepareVoucherBirth, finalizeVoucherBirths, replayBirth, persistBirth, birthResult, prepareMutation, persistMutation, mutationResult, assertMutationNode, managedVisit, publishCita, syncReminderIntents, reconcilePendingBirthIntents,
    sendContext, enqueueMessage, reuseMessage, deliveryWaiting, runDispatch, assertTransport, beginTransport });
  return api;
}
let singleton;
function current() { return singleton || (singleton = createAppointmentVisitManagedService({ db: require('../../models') })); }
module.exports = { createAppointmentVisitManagedService, current, planFor };
