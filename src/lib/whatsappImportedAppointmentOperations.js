'use strict';

// This server-side migration approval releases operational reservations, not
// patients or marketing. Import receipts and clinical provenance stay intact.
const fs = require('node:fs');
const runtime = require('./whatsappAuthorizedRuntime');
const { CITA_STATUS_VALUES } = require('./status-catalog');
const FILE = runtime.ROOTS.staging + '/imported-appointment-operations.json';
const CLINICS = new Set([66, 72]);
const STATUSES = new Set(CITA_STATUS_VALUES);
const ACTIVE_STATUSES = new Set([
  'pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado',
  'recordatorio_confirmado', 'reprogramada',
]);
const TRIGGERS = new Set([
  'appointment_created', 'appointment_reminder_window', 'appointment_after',
  'appointment_confirmed', 'appointment_no_show', 'appointment_rescheduled',
  'appointment_cancelled', 'appointment_completed', 'consent_required',
]);
const SUPPRESSION_KEYS = new Set(['appointment_details', 'day_before', 'same_day']);
const positive = value => Number.isSafeInteger(value) && value > 0;
const entityId = value => typeof value !== 'boolean' && value != null && value !== '' && positive(Number(value));
const iso = value => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value));
const instant = value => value == null || value === '' ? NaN : new Date(value).getTime();
const text = value => String(value ?? '').trim().toLowerCase();
const truth = value => value === true || value === 1 || value === '1' || value === 'true';
const object = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
const plain = value => value?.toJSON ? value.toJSON() : value;
let cache;

function validate(value, { now = Date.now() } = {}) {
  if (!value || value.version !== 1 || value.purpose !== 'appointment_operations'
    || !positive(value.approvedBy) || !/^[a-zA-Z0-9:_-]{1,100}$/.test(value.approvalRef || '')
    || !iso(value.approvedAt) || Date.parse(value.approvedAt) > now
    || value.automaticBacklogReplay !== false || value.sameDayAllowed !== false
    || !Array.isArray(value.clinicIds) || !value.clinicIds.length
    || value.clinicIds.some(id => !positive(id) || !CLINICS.has(id))
    || new Set(value.clinicIds).size !== value.clinicIds.length) {
    throw Error('invalid_imported_appointment_operations');
  }
  return Object.freeze({
    version: 1, purpose: 'appointment_operations', approvedBy: value.approvedBy,
    approvalRef: value.approvalRef, approvedAt: value.approvedAt,
    clinicIds: Object.freeze([...value.clinicIds]), automaticBacklogReplay: false, sameDayAllowed: false,
  });
}

function read(env = process.env) {
  // The isolated DEV API and ingress gateway cannot activate a live release.
  if (env.WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE !== runtime.ROOTS.staging + '/config.json') return null;
  try {
    if (runtime.namespace(env) !== 'staging' || fs.realpathSync(FILE) !== FILE) return null;
    const stat = fs.statSync(FILE);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size < 1 || stat.size > 65536) return null;
    const revision = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    if (cache?.revision === revision) return cache.policy;
    const policy = validate(JSON.parse(fs.readFileSync(FILE, 'utf8')));
    cache = { revision, policy };
    return policy;
  } catch { cache = null; return null; }
}

function isHistorical(appointment) {
  const a = plain(appointment), m = object(a?.import_metadata);
  const normalized = value => text(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const source = text(a?.source_system), kind = text(m.kind);
  return source === 'lead_resolution_historical' || source === 'clinicaclick_reactivation_import'
    || truth(m.historical_registration) || truth(m.imported_as_past_activity)
    || ['lead_resolution_historical', 'historical_treatment'].includes(kind)
    || text(a?.tipo_cita) === 'historico_importado'
    || normalized(a?.motivo).startsWith('importacion de pacientes')
    || normalized(a?.titulo).startsWith('historico:');
}

function allowsOperationalAppointment(appointment, { policy = read(), now = Date.now() } = {}) {
  const a = plain(appointment), m = object(a?.import_metadata);
  const approvedAt = instant(policy?.approvedAt), start = instant(a?.inicio);
  return !!policy && policy.version === 1 && policy.purpose === 'appointment_operations'
    && policy.automaticBacklogReplay === false && policy.sameDayAllowed === false
    && Number.isFinite(approvedAt) && approvedAt <= now
    && Array.isArray(policy.clinicIds) && CLINICS.has(Number(a?.clinica_id))
    && policy.clinicIds.includes(Number(a.clinica_id))
    && !isHistorical(a)
    && !m.qa_demo && !truth(m.synthetic_data_only)
    && entityId(a.id_cita) && entityId(a.paciente_id) && !truth(a.es_provisional)
    && Number.isFinite(start) && start >= approvedAt && STATUSES.has(text(a.estado));
}

function allowsAppointment(appointment, { policy = read(), now = Date.now() } = {}) {
  return text(plain(appointment)?.source_system) === 'cliniccloud'
    && allowsOperationalAppointment(appointment, { policy, now });
}

function appointmentHeld(value) {
  const m = object(value);
  return m.automation_policy === 'hold' || m.automationPolicy === 'hold' || m.messages_enabled === false
    || ['import', 'cliniccloud_reconciliation'].some(key => m[key] && appointmentHeld(m[key]));
}

function allowsNativePatientHoldOverride(appointment, { policy = read(), now = Date.now() } = {}) {
  const a = plain(appointment);
  // A new operational booking for an imported patient is not historical just
  // because the patient's old import field still carries HOLD. This never
  // releases an appointment with its own provenance or suppression policy.
  return allowsOperationalAppointment(a, { policy, now })
    && !text(a.source_system) && !text(a.source_reference) && !appointmentHeld(a.import_metadata)
    && instant(a.inicio) > now && ACTIVE_STATUSES.has(text(a.estado));
}

function allowsSuppressionOverride(appointment, { policy = read(), now = Date.now() } = {}) {
  if (!allowsAppointment(appointment, { policy, now })) return false;
  const m = object(plain(appointment)?.import_metadata);
  const raw = object(m.notification_suppression || m.notificationSuppression);
  const keys = Object.keys(raw);
  const importerHeld = object(m.cliniccloud_reconciliation).automation_policy === 'hold'
    || object(m.import).automation_policy === 'hold'
    || m.automation_policy === 'hold' || m.messages_enabled === false;
  // Manual selection, locked suppressions, aliases and unknown keys are never
  // interpreted as the importer's technical default, even when set to false.
  return importerHeld && keys.length > 0
    && keys.every(key => SUPPRESSION_KEYS.has(key) && typeof raw[key] === 'boolean');
}

function matchesFreshExecution(appointment, { execution, policy, now }) {
  const a = plain(appointment), e = plain(execution);
  if (!e) return false;
  const createdAt = instant(e.created_at), context = object(e.context), captured = object(context.appointment);
  if (e.trigger_entity_type !== 'appointment' || !TRIGGERS.has(e.trigger_type)
    || Number(e.trigger_entity_id) !== Number(a.id_cita) || Number(e.clinic_id) !== Number(a.clinica_id)
    || !Number.isFinite(createdAt) || createdAt < Date.parse(policy.approvedAt) || createdAt > now
    || instant(captured.inicio) !== instant(a.inicio)) return false;
  for (const [field, expected] of [
    ['id_cita', a.id_cita], ['clinica_id', a.clinica_id], ['paciente_id', a.paciente_id],
  ]) {
    if (Object.hasOwn(captured, field) && Number(captured[field]) !== Number(expected)) return false;
  }
  return true;
}

function permits(appointment, { execution, policy = read(), now = Date.now() } = {}) {
  return allowsAppointment(appointment, { policy, now })
    && matchesFreshExecution(appointment, { execution, policy, now });
}

function permitsPatientHoldOverride(appointment, { execution, policy = read(), now = Date.now() } = {}) {
  return (allowsAppointment(appointment, { policy, now })
      || allowsNativePatientHoldOverride(appointment, { policy, now }))
    && matchesFreshExecution(appointment, { execution, policy, now });
}

async function permitsReply(conversation, message, db, transaction, { policy = read(), now = Date.now() } = {}) {
  const c = plain(conversation), inbound = plain(message), inboundAt = instant(inbound?.sent_at);
  if (!policy || !CLINICS.has(Number(c?.clinic_id)) || !policy.clinicIds?.includes(Number(c.clinic_id))
    || !entityId(c.id) || !entityId(c.patient_id) || !Number.isFinite(inboundAt)
    || inboundAt < Date.parse(policy.approvedAt) || inboundAt > now
    || inbound.direction && inbound.direction !== 'inbound'
    || inbound.conversation_id != null && Number(inbound.conversation_id) !== Number(c.id)) return false;
  const [rows] = await db.sequelize.query(`SELECT e.id,e.clinic_id,e.template_version_id,e.trigger_type,
    e.trigger_entity_type,e.trigger_entity_id,e.created_at,e.context,e.status
    FROM FlowExecutionsV2 e WHERE e.clinic_id=:clinicId AND e.trigger_entity_type='appointment'
    AND e.trigger_type IN (:triggerTypes) AND e.status IN ('running','waiting') AND e.created_at>=:approvedAt
    AND EXISTS (SELECT 1 FROM Messages m WHERE m.conversation_id=:conversationId AND m.direction='outbound'
      AND m.message_type<>'event'
      AND m.status IN ('sent','delivered','read') AND m.createdAt>=:approvedAt
      AND m.sent_at>=:approvedAt AND m.sent_at<=:inboundAt
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.execution_id')) AS UNSIGNED)=e.id)
    ORDER BY e.created_at DESC,e.id DESC LIMIT 100`,
  { transaction, replacements: { clinicId: Number(c.clinic_id), triggerTypes: [...TRIGGERS],
    approvedAt: new Date(policy.approvedAt), conversationId: c.id, inboundAt: new Date(inboundAt) } });
  for (const e of rows) {
    if (!['running', 'waiting'].includes(e.status)) continue;
    const a = await db.CitaPaciente.findByPk(e.trigger_entity_id, { raw: true, transaction });
    if (Number(a?.paciente_id) === Number(c.patient_id) && instant(a?.inicio) > now
      && ACTIVE_STATUSES.has(text(a?.estado)) && permitsPatientHoldOverride(a, { execution: e, policy, now })) return true;
  }
  return false;
}

module.exports = { FILE, validate, read, isHistorical, allowsAppointment,
  allowsSuppressionOverride, permits, permitsPatientHoldOverride, permitsReply };
