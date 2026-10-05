'use strict';

// An operator-reviewed, exact-reservation release. Never stored in client DTOs
// or import metadata: modifying those would invalidate clinical source receipts.
const fs = require('node:fs');
const runtime = require('./whatsappAuthorizedRuntime');
const FILE = runtime.ROOTS.staging + '/imported-day-before-release.json';
const id = n => Number.isSafeInteger(n) && n > 0;
const iso = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s));
const instant = v => v == null ? NaN : new Date(v).getTime();
let cache;
function validate(p) {
  if (!p || p.version !== 1 || p.purpose !== 'day_before_reminder' || !id(p.approvedBy)
    || !/^[a-zA-Z0-9:_-]{1,100}$/.test(p.approvalRef || '') || !iso(p.approvedAt)
    || !iso(p.startsNotBefore) || !iso(p.expiresAt) || Date.parse(p.expiresAt) <= Date.parse(p.approvedAt)
    || p.automaticBacklogReplay !== false || p.sameDayAllowed !== false
    || !Array.isArray(p.appointments) || !p.appointments.length || p.appointments.length > 5000) throw Error('invalid_imported_reminder_release');
  const index = new Map();
  for (const a of p.appointments) {
    if (!id(a.id) || !id(a.clinicId) || !id(a.patientId) || !id(a.templateVersionId) || !iso(a.startAt)
      || Date.parse(a.startAt) < Date.parse(p.startsNotBefore)
      || !(a.sourceSystem === null || a.sourceSystem === 'cliniccloud')
      || !(a.sourceReference === null || typeof a.sourceReference === 'string' && a.sourceReference.length <= 120)
      || index.has(a.id)) throw Error('invalid_imported_reminder_release');
    index.set(a.id, a);
  }
  return { ...p, index };
}
function read(env = process.env) {
  // DEV, gateway and offline tests cannot read the live release registry.
  if (env.WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE !== runtime.ROOTS.staging + '/config.json') return null;
  try {
    if (runtime.namespace(env) !== 'staging' || fs.realpathSync(FILE) !== FILE) return null;
    const stat = fs.statSync(FILE);
    if (!stat.isFile() || stat.mode & 0o077 || stat.size < 1 || stat.size > 2 * 1024 * 1024) return null;
    const revision = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    if (cache?.revision === revision) return cache.policy;
    const policy = validate(JSON.parse(fs.readFileSync(FILE, 'utf8')));
    cache = { revision, policy };
    return policy;
  } catch { cache = null; return null; }
}
function permits(appointment, { templateVersionId, execution, now = Date.now(), policy = read() } = {}) {
  const a = appointment?.toJSON ? appointment.toJSON() : appointment;
  if (!policy || !a || now < Date.parse(policy.approvedAt) || now >= Date.parse(policy.expiresAt)) return false;
  const item = policy.index.get(Number(a.id_cita));
  if (!item || Number(a.clinica_id) !== item.clinicId || Number(a.paciente_id) !== item.patientId
    || instant(a.inicio) !== Date.parse(item.startAt) || (a.source_system || null) !== item.sourceSystem
    || (a.source_reference || null) !== item.sourceReference) return false;
  if (templateVersionId != null && Number(templateVersionId) !== item.templateVersionId) return false;
  if (execution && (Number(execution.template_version_id) !== item.templateVersionId
    || execution.trigger_type !== 'appointment_reminder_window'
    || execution.trigger_entity_type !== 'appointment'
    || Number(execution.trigger_entity_id) !== item.id || Number(execution.clinic_id) !== item.clinicId
    || !Number.isFinite(instant(execution.created_at)) || instant(execution.created_at) < Date.parse(policy.approvedAt))) return false;
  return true;
}
async function permitsReply(conversation, message, db, transaction, { policy = read(), now = Date.now() } = {}) {
  if (!policy || !conversation?.patient_id) return false;
  const ids = [...policy.index.values()].filter(a => a.clinicId === Number(conversation.clinic_id)
    && a.patientId === Number(conversation.patient_id)).map(a => a.id);
  if (!ids.length) return false;
  // The inbound must follow an accepted reminder in this exact conversation.
  // No replay of pre-release messages and no patient-wide automation exemption.
  const [rows] = await db.sequelize.query(`SELECT e.id,e.clinic_id,e.template_version_id,e.trigger_type,
    e.trigger_entity_type,e.trigger_entity_id,e.created_at
    FROM FlowExecutionsV2 e WHERE e.clinic_id=:clinicId AND e.trigger_entity_type='appointment'
    AND e.trigger_entity_id IN (:ids) AND e.status IN ('running','waiting') AND e.created_at>=:approvedAt
    AND EXISTS (SELECT 1 FROM Messages m WHERE m.conversation_id=:conversationId AND m.direction='outbound'
      AND m.status IN ('sent','delivered','read') AND m.createdAt>=:approvedAt AND m.createdAt<=:inboundAt
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.execution_id')) AS UNSIGNED)=e.id)`,
  { transaction, replacements: { clinicId: conversation.clinic_id, ids, approvedAt: new Date(policy.approvedAt),
    conversationId: conversation.id, inboundAt: new Date(message.sent_at) } });
  for (const execution of rows) {
    const appointment = await db.CitaPaciente.findByPk(execution.trigger_entity_id, { raw: true, transaction });
    if (instant(appointment?.inicio) > now && permits(appointment, { execution, policy, now })) return true;
  }
  return false;
}
module.exports = { FILE, validate, read, permits, permitsReply };
