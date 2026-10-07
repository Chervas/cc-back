'use strict';

// Server composition only. No model bootstrap, registry file, worker or send.
const v = require('./appointment-visit-communication');
const calendar = require('./availability-calendar');
const reminders = require('./appointment-visit-reminder-policy');
const CONTRACT = 'appointment-visit-runtime/1';
const contracts = new WeakMap(), plans = new WeakMap(), mutationReceipts = new WeakMap();
const MUTATION_EVENT = 'appointment_visit_mutation';
const STAGES = Object.freeze({
  details: { purpose: 'appointment_details', triggers: ['appointment_created', 'appointment_rescheduled'], policy: 'details' },
  attendance_day_before: { purpose: 'reminder_day_before', triggers: ['appointment_reminder_window'], policy: 'day_before' },
  attendance_same_day: { purpose: 'reminder_same_day', triggers: ['appointment_reminder_window'], policy: 'same_day' },
  ack_details: { purpose: 'confirmation_acknowledgement', policy: 'ack', source: 'details' },
  ack_attendance: { purpose: 'confirmation_acknowledgement', policy: 'ack', source: 'attendance' },
  timeout_details: { purpose: 'confirmation_timeout', policy: 'timeout', source: 'details' },
  timeout_attendance: { purpose: 'confirmation_timeout', policy: 'timeout', source: 'attendance' },
  cancellation: { purpose: 'cancellation', triggers: ['appointment_cancelled'], policy: 'cancellation' },
});
const fail = suffix => v.fail('runtime_' + suffix);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const textKey = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,119}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function graphProjection(value) {
  const row = v.plain(value);
  return { entry_node_id: row.entry_node_id, trigger_type: row.trigger_type,
    trigger_config: row.trigger_config || {}, nodes: row.nodes };
}
function graphHash(template) { return v.hash(graphProjection(template)); }
function waitDuration(node) {
  const config = node.config || {}, amount = Number(config.timeout_duration ?? 60);
  const units = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 };
  const factor = units[config.timeout_unit || 'minutes'];
  if (!factor || !Number.isFinite(amount) || amount <= 0 || amount * factor > 7 * 86400000) fail('wait_policy_invalid');
  return amount * factor;
}
function compileManifest({ template: value, stages, mutations = [] }, clinicId, groupId) {
  const template = v.plain(value);
  if (!v.positiveId(Number(template?.id)) || !template.public_id || !template.template_key || !template.published_at
    || template.is_active !== true || template.engine_version !== 'v2' || v.qa(template)
    || template.clinic_id != null && Number(template.clinic_id) !== clinicId
    || template.clinic_id == null && template.group_id != null && Number(template.group_id) !== groupId
    || !Array.isArray(template.nodes) || !template.nodes.length || template.nodes.length > 256
    || !Array.isArray(stages) || !stages.length || !Array.isArray(mutations)) fail('manifest_invalid');
  const nodes = new Map(template.nodes.map(node => [node.id, node]));
  if (nodes.size !== template.nodes.length || !nodes.has(template.entry_node_id)) fail('graph_invalid');
  const reachable = new Set(), pending = [template.entry_node_id];
  while (pending.length) {
    const id = pending.pop(); if (reachable.has(id)) continue;
    const node = nodes.get(id); if (!node || typeof node.type !== 'string' || !exact(node.outputs || {}, Object.keys(node.outputs || {}))) fail('graph_invalid');
    reachable.add(id);
    for (const next of Object.values(node.outputs || {})) {
      if (next == null || next === '') continue;
      if (typeof next !== 'string' || !nodes.has(next)) fail('graph_invalid');
      pending.push(next);
    }
  }
  const mapped = new Map(), compiled = [], stageKeys = new Set();
  for (const stage of stages) {
    if (!exact(stage, ['key', 'node_ids', 'wait_node_ids', 'source_key', 'timeout_grace_ms', 'event_grace_ms']) || !STAGES[stage.key] || stageKeys.has(stage.key)
      || !Array.isArray(stage.node_ids) || stage.node_ids.length !== 1 || !Array.isArray(stage.wait_node_ids || [])) fail('stage_invalid');
    const policy = STAGES[stage.key]; stageKeys.add(stage.key);
    if (policy.policy === 'timeout' ? !Number.isInteger(stage.timeout_grace_ms) || stage.timeout_grace_ms < 1 || stage.timeout_grace_ms > 86400000
      : stage.timeout_grace_ms != null) fail('stage_window_policy_invalid');
    if (policy.policy === 'cancellation' ? !Number.isInteger(stage.event_grace_ms) || stage.event_grace_ms < 1 || stage.event_grace_ms > 86400000
      : stage.event_grace_ms != null) fail('stage_window_policy_invalid');
    if (policy.triggers && !policy.triggers.includes(template.trigger_type)) fail('stage_trigger_invalid');
    const triggerConfig = template.trigger_config || nodes.get(template.entry_node_id)?.config;
    if (policy.policy === 'day_before' && triggerConfig?.schedule_moment !== 'day_before'
      || policy.policy === 'same_day' && triggerConfig?.schedule_moment !== 'same_day'
      || ['day_before', 'same_day'].includes(policy.policy) && triggerConfig?.only_if_not_confirmed === true) fail('stage_trigger_invalid');
    const sourceKey = stage.source_key || null;
    if (policy.source && (policy.source === 'details' ? sourceKey !== 'details'
      : !['attendance_day_before', 'attendance_same_day'].includes(sourceKey)) || !policy.source && sourceKey) fail('stage_source_invalid');
    for (const nodeId of stage.node_ids) {
      if (!reachable.has(nodeId) || nodes.get(nodeId)?.type !== 'action/send_whatsapp' || mapped.has(nodeId)) fail('stage_node_invalid');
      mapped.set(nodeId, stage.key);
    }
    const waits = (stage.wait_node_ids || []).map(id => {
      const node = nodes.get(id);
      if (!reachable.has(id) || node?.type !== 'delay/wait_response' || !stage.node_ids.includes(node.config?.listens_to_node_id)) fail('wait_policy_invalid');
      return { node_id: id, listens_to_node_id: node.config.listens_to_node_id, duration_ms: waitDuration(node) };
    });
    if (new Set(waits.map(wait => wait.node_id)).size !== waits.length) fail('wait_policy_invalid');
    compiled.push({ key: stage.key, purpose: policy.purpose, policy: policy.policy, source_key: sourceKey,
      node_ids: [...stage.node_ids].sort(), waits, ...(policy.policy === 'timeout' ? { timeout_grace_ms: stage.timeout_grace_ms } : {}),
      ...(policy.policy === 'cancellation' ? { event_grace_ms: stage.event_grace_ms } : {}) });
  }
  for (const stage of compiled) if (stage.source_key && !compiled.some(source => source.key === stage.source_key && source.waits.length)) fail('stage_source_invalid');
  const mutationMap = new Map();
  for (const mutation of mutations) {
    if (!exact(mutation, ['node_id', 'new_status']) || mutationMap.has(mutation.node_id)
      || !reachable.has(mutation.node_id) || nodes.get(mutation.node_id)?.type !== 'action/change_status'
      || nodes.get(mutation.node_id).config?.target_entity !== 'appointment'
      || nodes.get(mutation.node_id).config?.new_status !== mutation.new_status
      || !['info_confirmada', 'recordatorio_confirmado', 'cambio_solicitado', 'cancelada'].includes(mutation.new_status)) fail('mutation_invalid');
    mutationMap.set(mutation.node_id, mutation.new_status);
  }
  for (const id of reachable) {
    const node = nodes.get(id);
    if (node.type === 'action/send_email') fail('email_binding_unavailable');
    if (node.type === 'action/send_whatsapp' && !mapped.has(id)) fail('unmapped_send');
    if (node.type === 'action/change_status' && !mutationMap.has(id)) fail('unmapped_mutation');
    if (node.type.startsWith('action/') && !['action/send_whatsapp', 'action/change_status', 'action/send_system_notification'].includes(node.type)) fail('unsupported_action');
    if (node.type === 'delay/wait_response' && !compiled.some(stage => stage.waits.some(wait => wait.node_id === id))) fail('unmapped_wait');
  }
  return { template_version_id: Number(template.id), public_id: template.public_id, template_key: template.template_key,
    trigger_type: template.trigger_type, graph_sha256: graphHash(template), stages: compiled.sort((a, b) => a.key.localeCompare(b.key)),
    mutations: [...mutationMap].map(([node_id, new_status]) => ({ node_id, new_status })).sort((a, b) => a.node_id.localeCompare(b.node_id)) };
}
function compileEnrollmentContract({ clinicId, groupId = null, timeZone, manifests, runtimeNamespace = null, reminderBindings = undefined }) {
  if (!v.positiveId(clinicId) || groupId != null && !v.positiveId(groupId) || !calendar.isValidTimeZone(timeZone)
    || runtimeNamespace != null && (typeof runtimeNamespace !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(runtimeNamespace))
    || !Array.isArray(manifests) || !manifests.length || manifests.length > 16) fail('contract_invalid');
  const result = { schema: CONTRACT, clinic_id: clinicId, group_id: groupId, time_zone: timeZone,
    ...(runtimeNamespace == null ? {} : { runtime_namespace: runtimeNamespace }),
    manifests: manifests.map(manifest => compileManifest(manifest, clinicId, groupId)).sort((a, b) => a.template_version_id - b.template_version_id) };
  if (new Set(result.manifests.map(manifest => manifest.template_version_id)).size !== result.manifests.length) fail('contract_invalid');
  if (reminderBindings !== undefined) {
    result.reminder_bindings = reminders.normalizeBindings(reminderBindings);
    for (const selected of result.reminder_bindings) stageDefinition(result, selected.template_version_id, selected.stage_key);
  }
  const token = Object.freeze({ schema: CONTRACT }); contracts.set(token, v.clone(result)); return token;
}
function compiledContract(token) {
  const result = contracts.get(token); if (!result) fail('server_contract_required'); return v.clone(result);
}
function assertManagedEligibility(value, purpose, now, { voucherOriginProof = null, transaction = null } = {}) {
  const row = v.plain(value), metadata = v.object(row.import_metadata);
  const origin = voucherOriginProof ? require('./voucher-booking-origin').proofOrigin(voucherOriginProof, { transaction, appointment: row }) : null;
  if (row.source_system || row.source_reference || row.voucher_id && !origin || metadata.program_session
    || metadata.clinical_component_parent || metadata.clinical_component_children || metadata.historical_registration
    || metadata.imported_as_past_activity || row.hold_expires_at || row.es_provisional || v.held(metadata) || v.qa(row)) fail('birth_ineligible');
  const suppression = v.object(metadata.notification_suppression || metadata.notificationSuppression);
  if (Object.values(suppression).some(value => value === true || value === 1 || value === 'true' || value === '1')) fail('birth_ineligible');
  v.assertNotificationEligibility({ appointments: [row], purpose, now });
  if (metadata.booking?.profile?.version !== 4 || metadata.booking.capacity_fully_verified !== true
    || v.bookingProjection(row).steps.length < (origin ? 1 : 2)) fail('birth_ineligible');
}
const assertBirthEligibility = (value, now, options) => assertManagedEligibility(value, 'appointment_details', now, options);

// A mutation window is anchored to an append-only SQL event read by the runtime,
// not updated_at, an HTTP event timestamp or a serialized proof. Keeping this
// receipt separate leaves the original enrollment/hash and all old intents intact.
function captureMutationReceipt(value, visit) {
  const row = v.plain(value), metadata = v.object(row?.metadata), event = v.object(metadata.mutation);
  if (!row || row.event_type !== MUTATION_EVENT || row.source !== 'appointment_visit_runtime'
    || !/^[1-9][0-9]{0,19}$/.test(String(row.id || '')) || !v.positiveId(Number(row.actor_user_id))
    || Number(row.clinic_id) !== Number(visit.clinic_id) || Number(row.patient_id) !== Number(visit.patient_id)
    || metadata.mutation_sha256 !== v.hash(event) || event.schema !== 'appointment-visit-mutation/1'
    || event.visit_id !== visit.id || event.owner_appointment_id !== Number(visit.owner_appointment_id)
    || event.communication_revision !== Number(visit.communication_revision)
    || event.before_revision !== event.communication_revision - 1 || !v.positiveId(event.before_revision)
    || !['rescheduled', 'cancelled', 'lifecycle_changed'].includes(event.kind)
    || event.actor_id !== Number(row.actor_user_id) || typeof event.suppressed !== 'boolean'
    || event.snapshot_sha256 !== visit.snapshot_sha256 || event.membership_sha256 !== visit.membership_sha256
    || event.before_snapshot_sha256 !== v.hash(event.before_snapshot) || event.snapshot_sha256 !== v.hash(event.snapshot)
    || Math.floor(new Date(row.occurred_at).getTime() / 1000) !== Math.floor(Date.parse(v.instant(event.recorded_at)) / 1000)) fail('mutation_receipt_invalid');
  const token = Object.freeze({ schema: 'appointment-visit-mutation/1' });
  mutationReceipts.set(token, { ...v.clone(event), event_id: String(row.id), event_sha256: metadata.mutation_sha256 }); return token;
}
function mutationReceipt(token, visit) {
  const row = mutationReceipts.get(token);
  if (!row || row.visit_id !== visit.id || row.communication_revision !== Number(visit.communication_revision)
    || row.snapshot_sha256 !== visit.snapshot_sha256 || row.membership_sha256 !== visit.membership_sha256) fail('mutation_event_required');
  return row;
}
function birthProjectionHash({ clinicId, patientId, plan, voucherOriginProof = null, transaction = null }) {
  if (!v.positiveId(clinicId) || !v.positiveId(patientId) || !exact(plan, ['start_at', 'end_at', 'treatment_id', 'doctor_id', 'installation_id', 'booking', 'additional_staff'])) fail('birth_plan_invalid');
  const origin = voucherOriginProof ? require('./voucher-booking-origin').proofOrigin(voucherOriginProof, { transaction }) : null;
  const appointment = { id_cita: 1, clinica_id: clinicId, paciente_id: patientId, inicio: v.instant(plan.start_at), fin: v.instant(plan.end_at),
    doctor_id: plan.doctor_id ?? null, instalacion_id: plan.installation_id ?? null, tratamiento_id: plan.treatment_id ?? null,
    ...(origin ? { voucher_id: origin.voucher_id } : {}),
    estado: 'pendiente', import_metadata: { booking: plan.booking, ...(plan.additional_staff ? { additional_staff: plan.additional_staff } : {}) } };
  assertBirthEligibility(appointment, new Date(Date.parse(appointment.inicio) - 1), { voucherOriginProof, transaction });
  const projection = v.buildVisitSnapshot({ visitId: '00000000-0000-4000-8000-000000000001', ownerAppointmentId: 1,
    appointments: [appointment], members: [{ appointment_id: 1, visit_id: '00000000-0000-4000-8000-000000000001', clinic_id: clinicId, patient_id: patientId, role: 'primary', evidence: {} }], groupingKind: 'singleton' });
  return projection.snapshot_sha256;
}
function birthRequestHash({ clinicId, patientId, plan }) { return birthProjectionHash({ clinicId, patientId, plan }); }
function voucherBirthRequestHash({ clinicId, patientId, plan, voucherOriginProof, transaction }) {
  const origin = require('./voucher-booking-origin').proofOrigin(voucherOriginProof, { transaction });
  const booking = v.object(plan.booking);
  require('./booking-plan-receipt').assertBookingPlanReceipt(origin.slot_booking_plan_sha256, booking.profile, {
    start_at: plan.start_at, end_at: plan.end_at, phases: booking.phases,
    capacity_fully_verified: booking.capacity_fully_verified, attention_requirements_pending: booking.attention_requirements_pending,
    warnings: booking.warnings,
    requires_priority_acknowledgement: (booking.warnings || []).some(item => item.code === 'NON_PREFERRED_PROFESSIONAL'),
    requires_overlap_acknowledgement: booking.overlap_confirmed === true,
  });
  return v.hash({ schema: 'appointment-visit-voucher-birth/1', origin,
    physical_snapshot_sha256: birthProjectionHash({ clinicId, patientId, plan, voucherOriginProof, transaction }) });
}
function assertStoredEnrollment(visit) {
  const row = v.plain(visit), data = v.object(row.runtime_enrollment);
  if (data.schema !== CONTRACT || !digest(row.runtime_enrollment_sha256) || v.hash(data) !== row.runtime_enrollment_sha256
    || data.runtime_namespace != null && (typeof data.runtime_namespace !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(data.runtime_namespace))
    || row.grouping_kind !== 'singleton' || data.clinic_id !== Number(row.clinic_id) || !v.uuid(data.birth_request_key)
    || !digest(data.birth_request_sha256) || !Array.isArray(data.manifests) || !calendar.isValidTimeZone(data.time_zone)) fail('enrollment_invalid');
  if (data.origin != null) {
    const origin = require('./voucher-booking-origin').normalizeOrigin(data.origin);
    if (origin.clinic_id !== Number(row.clinic_id) || origin.patient_id !== Number(row.patient_id)
      || origin.actor_id !== data.actor_id || require('./voucher-booking-origin').childRequestKey(origin) !== data.birth_request_key) fail('enrollment_invalid');
  }
  if (data.reminder_bindings !== undefined) {
    v.instant(data.reminder_booked_at);
    for (const selected of reminders.normalizeBindings(data.reminder_bindings)) stageDefinition(data, selected.template_version_id, selected.stage_key);
  }
  return data;
}
function stageDefinition(enrollment, templateVersionId, stageKey) {
  const manifest = enrollment.manifests.find(item => item.template_version_id === templateVersionId);
  const stage = manifest?.stages.find(item => item.key === stageKey);
  if (!manifest || !stage || !STAGES[stageKey] || stage.purpose !== STAGES[stageKey].purpose) fail('stage_not_registered');
  return { manifest, stage };
}
function reviewedManifestMatches(manifest, reviewed, clinicId) {
  if (!reviewed || reviewed.clinic_id !== clinicId || reviewed.template_version_id !== manifest.template_version_id
    || reviewed.graph_sha256 !== manifest.graph_sha256 || !Array.isArray(reviewed.stages)) return false;
  const stages = reviewed.stages.map(stage => ({ key: stage.key, node_ids: [...(stage.node_ids || [])].sort(),
    wait_node_ids: [...(stage.wait_node_ids || [])].sort(), source_key: stage.source_key || null,
    timeout_grace_ms: stage.timeout_grace_ms ?? null, event_grace_ms: stage.event_grace_ms ?? null })).sort((a,b) => String(a.key).localeCompare(String(b.key)));
  const frozen = manifest.stages.map(stage => ({ key: stage.key, node_ids: stage.node_ids, wait_node_ids: stage.waits.map(wait => wait.node_id).sort(),
    source_key: stage.source_key, timeout_grace_ms: stage.timeout_grace_ms ?? null, event_grace_ms: stage.event_grace_ms ?? null }));
  const mutations = (reviewed.mutations || []).map(mutation => ({ node_id: mutation.node_id, new_status: mutation.new_status }))
    .sort((a,b) => String(a.node_id).localeCompare(String(b.node_id)));
  return v.canonical(stages) === v.canonical(frozen) && v.canonical(mutations) === v.canonical(manifest.mutations);
}
function addLocalDays(date, amount) {
  const next = new Date(date + 'T12:00:00.000Z'); next.setUTCDate(next.getUTCDate() + amount); return next.toISOString().slice(0, 10);
}
function semanticWindow({ visit, templateVersionId, stageKey, sourceWait = null, mutation = null }) {
  const enrollment = assertStoredEnrollment(visit), { manifest, stage } = stageDefinition(enrollment, templateVersionId, stageKey);
  const snapshot = v.object(visit.snapshot), start = v.instant(snapshot.patient_start_at), date = calendar.formatDateLocal(new Date(start), enrollment.time_zone);
  const midnight = local => v.instant(calendar.localDateTimeToUtc(local, '00:00:00', enrollment.time_zone));
  let key, from, to;
  if (stage.policy === 'details') {
    if (Number(visit.communication_revision) === 1) {
      if (manifest.trigger_type !== 'appointment_created' || mutation) fail('mutation_event_required');
      from = enrollment.enrolled_at;
    } else {
      const event = mutationReceipt(mutation, visit);
      if (event.kind !== 'rescheduled' || event.suppressed || manifest.trigger_type !== 'appointment_rescheduled') fail('mutation_event_required');
      from = event.recorded_at;
    }
    key = 'details'; to = start;
  } else if (stage.policy === 'cancellation') {
    const event = mutationReceipt(mutation, visit);
    if (event.kind !== 'cancelled' || event.suppressed || manifest.trigger_type !== 'appointment_cancelled') fail('mutation_event_required');
    key = 'cancellation'; from = event.recorded_at; to = v.instant(new Date(Date.parse(from) + stage.event_grace_ms));
  } else if (['day_before', 'same_day'].includes(stage.policy) && enrollment.reminder_bindings !== undefined) {
    const selected = reminders.selectedBinding(enrollment, templateVersionId, stageKey);
    const event = Number(visit.communication_revision) > 1 ? mutationReceipt(mutation, visit) : null;
    if (event && !['rescheduled', 'lifecycle_changed'].includes(event.kind)) fail('mutation_event_required');
    return { window: reminders.window({ enrollment, startAt: start, binding: selected,
      anchorAt: event?.recorded_at || enrollment.enrolled_at }), enrollment, stage };
  } else if (stage.policy === 'day_before') {
    key = 'day_before:' + date; from = midnight(addLocalDays(date, -1)); to = midnight(date);
  } else if (stage.policy === 'same_day') {
    key = 'same_day:' + date; from = midnight(date); to = start;
  } else {
    if (!sourceWait || sourceWait.schema !== 'appointment-visit-purpose-wait/1' || sourceWait.visit_id !== visit.id
      || sourceWait.communication_revision !== Number(visit.communication_revision) || sourceWait.stage_key !== stage.source_key) fail('source_wait_required');
    const source = stage.source_key === 'details' ? 'details' : 'attendance';
    key = stage.policy + ':' + source; from = stage.policy === 'ack' ? sourceWait.starts_at : sourceWait.due_at;
    to = v.instant(new Date(Math.min(Date.parse(sourceWait.cutoff_at), stage.policy === 'ack'
      ? Date.parse(sourceWait.due_at) : Date.parse(sourceWait.due_at) + stage.timeout_grace_ms)));
  }
  return { window: v.normalizeWindow({ key, starts_at: from, ends_at: to }), enrollment, stage };
}
function sealStagePlan({ visit, templateVersionId, stageKey, sourceWait = null, mutation = null }) {
  const { window, enrollment, stage } = semanticWindow({ visit, templateVersionId, stageKey, sourceWait, mutation });
  const receipt = mutation ? mutationReceipt(mutation, visit) : null;
  const stored = { schema: CONTRACT, enrollment_sha256: visit.runtime_enrollment_sha256, stage_key: stageKey,
    template_version_id: templateVersionId, purpose: stage.purpose, window_key: window.key,
    node_ids: stage.node_ids,
    source_communication_id: sourceWait?.source_communication_id || null, wait_node_id: sourceWait?.wait_node_id || null,
    ...(['day_before', 'same_day'].includes(stage.policy) && enrollment.reminder_bindings !== undefined
      ? { reminder_binding_sha256: v.hash(reminders.selectedBinding(enrollment, templateVersionId, stageKey)) } : {}),
    ...(receipt ? { mutation_event_id: receipt.event_id, mutation_event_sha256: receipt.event_sha256 } : {}) };
  const token = Object.freeze({ schema: CONTRACT }); plans.set(token, { visit_id: visit.id, revision: Number(visit.communication_revision), stored, window });
  return { token, stored, window, enrollment };
}
function stagePlan(token, visit, purpose, window) {
  const result = plans.get(token);
  if (!result || result.visit_id !== visit.id || result.revision !== Number(visit.communication_revision)
    || result.stored.enrollment_sha256 !== visit.runtime_enrollment_sha256 || result.stored.purpose !== purpose
    || v.canonical(result.window) !== v.canonical(v.normalizeWindow(window))) fail('server_stage_plan_required');
  return result;
}
function assertStageExecution({ visit, communication, execution }) {
  const enrollment = assertStoredEnrollment(visit), stored = v.object(communication.runtime_stage);
  if (stored.schema !== CONTRACT || v.hash(stored) !== communication.runtime_stage_sha256
    || stored.enrollment_sha256 !== visit.runtime_enrollment_sha256 || stored.purpose !== communication.purpose
    || stored.window_key !== communication.window_key || stored.template_version_id !== Number(execution.template_version_id)) fail('stage_binding_invalid');
  const { manifest, stage } = stageDefinition(enrollment, Number(execution.template_version_id), stored.stage_key);
  const context = v.object(v.object(execution.context).appointment_visit);
  if (manifest.trigger_type !== execution.trigger_type || stage.purpose !== communication.purpose
    || v.canonical(stored.node_ids) !== v.canonical(stage.node_ids)
    || context.visit_id !== visit.id || context.communication_revision !== Number(communication.communication_revision)
    || context.enrollment_sha256 !== visit.runtime_enrollment_sha256) fail('stage_binding_invalid');
  return { enrollment, manifest, stage };
}
module.exports = { CONTRACT, STAGES, compileEnrollmentContract, compiledContract, graphHash, waitDuration,
  assertBirthEligibility, assertManagedEligibility, birthRequestHash, voucherBirthRequestHash, assertStoredEnrollment, stageDefinition, semanticWindow,
  MUTATION_EVENT, captureMutationReceipt, mutationReceipt, reviewedManifestMatches,
  sealStagePlan, stagePlan, assertStageExecution, fail, textKey, digest };
