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
    || value.automaticBacklogReplay !== false || typeof value.sameDayAllowed !== 'boolean'
    || !Array.isArray(value.clinicIds) || !value.clinicIds.length
    || value.clinicIds.some(id => !positive(id) || !CLINICS.has(id))
    || new Set(value.clinicIds).size !== value.clinicIds.length) {
    throw Error('invalid_imported_appointment_operations');
  }
  return Object.freeze({
    version: 1, purpose: 'appointment_operations', approvedBy: value.approvedBy,
    approvalRef: value.approvalRef, approvedAt: value.approvedAt,
    clinicIds: Object.freeze([...value.clinicIds]), automaticBacklogReplay: false, sameDayAllowed: value.sameDayAllowed,
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
  try { policy = validate(policy, { now }); } catch { return false; }
  const a = plain(appointment), m = object(a?.import_metadata);
  const approvedAt = instant(policy?.approvedAt), start = instant(a?.inicio);
  return !!policy && policy.version === 1 && policy.purpose === 'appointment_operations'
    && policy.automaticBacklogReplay === false && typeof policy.sameDayAllowed === 'boolean'
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

function allowsSameDayAppointment(appointment, { policy = read(), now = Date.now() } = {}) {
  const a = plain(appointment);
  // This is an appointment-scoped operational authorization, not a patient
  // release. Past activity and technical/manual suppression remain distinct.
  return policy?.sameDayAllowed === true && instant(a?.inicio) > now
    && ACTIVE_STATUSES.has(text(a?.estado))
    && (allowsAppointment(a, { policy, now }) || allowsNativePatientHoldOverride(a, { policy, now }));
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

function permitsSameDay(appointment, { execution, policy = read(), now = Date.now() } = {}) {
  return plain(execution)?.trigger_type === 'appointment_reminder_window'
    && allowsSameDayAppointment(appointment, { policy, now })
    && matchesFreshExecution(appointment, { execution, policy, now });
}

function acceptedReplyOutbound(row, { conversationId, approvedAt, inboundAt }) {
  const createdAt = instant(row.outbound_created_at), sentAt = instant(row.outbound_sent_at);
  if (!entityId(row.outbound_id) || Number(row.outbound_conversation_id) !== Number(conversationId)
    || row.outbound_direction !== 'outbound' || !['text', 'image', 'template', 'reaction'].includes(row.outbound_message_type)
    || !['sent', 'delivered', 'read'].includes(row.outbound_status)
    || !Number.isFinite(createdAt) || createdAt < approvedAt || createdAt > inboundAt) return false;
  const receipt = object(row.outbound_receipt);
  if (truth(receipt.historical) || truth(receipt.qa_demo) || truth(receipt.synthetic_data_only)) return false;
  // The actual provider "sent" receipt remains authoritative when present.
  if (row.outbound_sent_at != null && row.outbound_sent_at !== '') {
    return Number.isFinite(sentAt) && sentAt >= approvedAt && sentAt <= inboundAt;
  }
  // API acceptance deliberately leaves sent_at NULL until a factual sent
  // webhook arrives. Delivered/read may arrive first. Require both the real
  // provider message ID and a provider receipt clock; createdAt alone is not
  // evidence of sending and must never resume an old/unsent notification.
  const providerId = value => typeof value === 'string' && /^wamid\.[A-Za-z0-9+/=_-]{1,500}$/.test(value);
  const wamid = receipt.wamid, responseId = receipt.response_id;
  if (!providerId(wamid) && !providerId(responseId) || wamid && responseId && wamid !== responseId) return false;
  const clocks = [];
  if (iso(receipt.provider_acceptance_at)) clocks.push(instant(receipt.provider_acceptance_at));
  const epochClock = value => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]{1,12}$/.test(value))) return NaN;
    const seconds = Number(value);
    return positive(seconds) && Number.isFinite(new Date(seconds * 1000).getTime()) ? seconds * 1000 : NaN;
  };
  const timestamps = object(receipt.wa_status_timestamps);
  for (const status of ['sent', 'delivered', 'read']) {
    const clock = epochClock(timestamps[status]);
    if (Number.isFinite(clock)) clocks.push(clock);
  }
  const providerStatus = object(receipt.wa_status);
  if (['sent', 'delivered', 'read'].includes(providerStatus.status)) {
    const clock = epochClock(providerStatus.timestamp);
    if (Number.isFinite(clock)) clocks.push(clock);
  }
  const earliest = Math.min(...clocks);
  return Number.isFinite(earliest) && earliest >= approvedAt && earliest <= inboundAt;
}

async function readReplyExecutions(c, inboundAt, db, transaction, policy, executionId = null) {
  const [rows] = await db.sequelize.query(`SELECT e.id,e.clinic_id,e.template_version_id,e.trigger_type,
    e.trigger_entity_type,e.trigger_entity_id,e.created_at,e.context,e.status,
    m.id AS outbound_id,m.conversation_id AS outbound_conversation_id,m.direction AS outbound_direction,
    m.message_type AS outbound_message_type,m.status AS outbound_status,
    m.createdAt AS outbound_created_at,m.sent_at AS outbound_sent_at,
    JSON_OBJECT('wamid',JSON_EXTRACT(m.metadata,'$.wamid'),
      'response_id',JSON_EXTRACT(m.metadata,'$.wa_response.messages[0].id'),
      'provider_acceptance_at',JSON_EXTRACT(m.metadata,'$.provider_acceptance_at'),
      'wa_status_timestamps',JSON_EXTRACT(m.metadata,'$.wa_status_timestamps'),
      'wa_status',JSON_OBJECT('status',JSON_EXTRACT(m.metadata,'$.wa_status.status'),
        'timestamp',JSON_EXTRACT(m.metadata,'$.wa_status.timestamp')),
      'historical',JSON_EXTRACT(m.metadata,'$.historical'),
      'qa_demo',JSON_EXTRACT(m.metadata,'$.qa_demo'),
      'synthetic_data_only',JSON_EXTRACT(m.metadata,'$.synthetic_data_only')) AS outbound_receipt
    FROM FlowExecutionsV2 e JOIN Messages m
      ON CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.execution_id')) AS UNSIGNED)=e.id
    WHERE e.clinic_id=:clinicId AND e.trigger_entity_type='appointment'
    AND e.trigger_type IN (:triggerTypes) AND e.status IN ('running','waiting') AND e.created_at>=:approvedAt
    ${executionId == null ? '' : 'AND e.id=:executionId'}
    AND m.conversation_id=:conversationId AND m.direction='outbound'
      AND m.message_type<>'event'
      AND m.status IN ('sent','delivered','read') AND m.createdAt>=:approvedAt AND m.createdAt<=:inboundAt
      AND (m.sent_at IS NULL OR m.sent_at>=:approvedAt AND m.sent_at<=:inboundAt)
    ORDER BY e.created_at DESC,e.id DESC,m.createdAt DESC,m.id DESC LIMIT 100`,
  { transaction, replacements: { clinicId: Number(c.clinic_id), triggerTypes: [...TRIGGERS],
    approvedAt: new Date(policy.approvedAt), conversationId: c.id, inboundAt: new Date(inboundAt),
    ...(executionId == null ? {} : { executionId }) } });
  return rows;
}

async function permitsReply(conversation, message, db, transaction, { policy = read(), now = Date.now() } = {}) {
  try { policy = validate(policy, { now }); } catch { return false; }
  const c = plain(conversation), inbound = plain(message), inboundAt = instant(inbound?.sent_at);
  if (!policy || !CLINICS.has(Number(c?.clinic_id)) || !policy.clinicIds?.includes(Number(c.clinic_id))
    || !entityId(c.id) || !entityId(c.patient_id) || !Number.isFinite(inboundAt)
    || inboundAt < Date.parse(policy.approvedAt) || inboundAt > now
    || inbound.direction && inbound.direction !== 'inbound'
    || inbound.conversation_id != null && Number(inbound.conversation_id) !== Number(c.id)) return false;
  const rows = await readReplyExecutions(c, inboundAt, db, transaction, policy);
  for (const e of rows) {
    if (!['running', 'waiting'].includes(e.status) || !acceptedReplyOutbound(e, {
      conversationId: c.id, approvedAt: Date.parse(policy.approvedAt), inboundAt,
    })) continue;
    const a = await db.CitaPaciente.findByPk(e.trigger_entity_id, { raw: true, transaction });
    if (Number(a?.paciente_id) === Number(c.patient_id) && instant(a?.inicio) > now
      && ACTIVE_STATUSES.has(text(a?.estado)) && permitsPatientHoldOverride(a, { execution: e, policy, now })) return true;
  }
  return false;
}

async function permitsNativeReplyAcknowledgement(appointment, { execution, conversation, message, payload,
  db, transaction = null, policy = read(), now = Date.now() } = {}) {
  try { policy = validate(policy, { now }); } catch { return false; }
  const a = plain(appointment), e = plain(execution), c = plain(conversation), outbound = plain(message);
  const metadata = object(outbound?.metadata), context = object(e?.context), response = object(context.last_response_context);
  const name = payload?.type === 'template' ? payload.template?.name : metadata.template_name || metadata.fallback_template_name;
  // Only continuation of a real reminder reply after cancellation is exempted.
  // No new cancellation flow, template-family release or patient-wide permit.
  if (!db?.sequelize?.query || !a || text(a.estado) !== 'cancelada' || instant(a.inicio) <= now
    || !allowsOperationalAppointment(a, { policy, now }) || text(a.source_system) || text(a.source_reference)
    || appointmentHeld(a.import_metadata) || e?.trigger_type !== 'appointment_reminder_window'
    || !['running', 'waiting'].includes(e?.status) || !entityId(e?.id)
    || !matchesFreshExecution(a, { execution: e, policy, now })
    || !entityId(c?.id) || Number(c.clinic_id) !== Number(a.clinica_id) || Number(c.patient_id) !== Number(a.paciente_id)
    || !entityId(outbound?.id) || outbound.direction !== 'outbound' || Number(outbound.conversation_id) !== Number(c.id)
    || !['text', 'template'].includes(outbound.message_type)
    || Number(metadata.execution_id) !== Number(e.id) || truth(metadata.appointment_timeout)
    || metadata.appointment_timeout == null && context.whatsapp_no_response_timeout === true
    || !['', 'care', 'appointment_operations'].includes(text(metadata.communication_scope))
    || /^(clinicaclick_recordatorio_|clinicaclick_confirmacion_datos_cita_)/.test(name || '')
    || /consent|review|rese[nñ]a|marketing|survey|encuesta/i.test(name || '')
    || !entityId(response.response_message_id)) return false;
  for (const [field, expected] of [['id_cita', a.id_cita], ['clinica_id', a.clinica_id], ['paciente_id', a.paciente_id]]) {
    if (Number(context.appointment?.[field]) !== Number(expected)) return false;
  }
  const [inbounds] = await db.sequelize.query(`SELECT id,conversation_id,direction,sent_at,
    JSON_OBJECT('historical',JSON_EXTRACT(metadata,'$.historical'),
      'qa_demo',JSON_EXTRACT(metadata,'$.qa_demo'),'synthetic_data_only',JSON_EXTRACT(metadata,'$.synthetic_data_only'),
      'revoked',JSON_EXTRACT(metadata,'$.revoked'),'revoked_at',JSON_EXTRACT(metadata,'$.revoked_at'),
      'revoke',JSON_EXTRACT(metadata,'$.revoke'),'coexistence_revoked_at',JSON_EXTRACT(metadata,'$.coexistence.revoked_at'),
      'coexistence_last_event',JSON_EXTRACT(metadata,'$.coexistence.last_event')) AS receipt
    FROM Messages WHERE id=:responseMessageId AND conversation_id=:conversationId AND direction='inbound' LIMIT 1`,
  { transaction, replacements: { responseMessageId: Number(response.response_message_id), conversationId: Number(c.id) } });
  const inbound = inbounds[0], inboundAt = instant(inbound?.sent_at), inboundReceipt = object(inbound?.receipt);
  if (Number(inbound?.id) !== Number(response.response_message_id) || inbound?.direction !== 'inbound'
    || Number(inbound.conversation_id) !== Number(c.id) || !Number.isFinite(inboundAt)
    || inboundAt < Date.parse(policy.approvedAt) || inboundAt > now
    || truth(inboundReceipt.historical) || truth(inboundReceipt.qa_demo) || truth(inboundReceipt.synthetic_data_only)
    || truth(inboundReceipt.revoked) || inboundReceipt.revoked_at || inboundReceipt.revoke
    || inboundReceipt.coexistence_revoked_at || text(inboundReceipt.coexistence_last_event) === 'revoke') return false;
  const rows = await readReplyExecutions(c, inboundAt, db, transaction, policy, Number(e.id));
  return rows.some(row => Number(row.id) === Number(e.id) && ['running', 'waiting'].includes(row.status)
    && row.trigger_type === 'appointment_reminder_window'
    && Number(object(row.context).last_response_context?.response_message_id) === Number(response.response_message_id)
    && ['id_cita', 'clinica_id', 'paciente_id'].every(field => Number(object(row.context).appointment?.[field]) === Number(a[field]))
    && matchesFreshExecution(a, { execution: row, policy, now })
    && acceptedReplyOutbound(row, { conversationId: c.id, approvedAt: Date.parse(policy.approvedAt), inboundAt }));
}

module.exports = { FILE, validate, read, isHistorical, allowsAppointment,
  allowsSameDayAppointment, allowsSuppressionOverride, permits, permitsSameDay, permitsPatientHoldOverride, permitsReply,
  permitsNativeReplyAcknowledgement };
