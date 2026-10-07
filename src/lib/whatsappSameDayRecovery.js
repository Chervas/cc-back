'use strict';
// Exact, operator-approved recovery for 07/10/2026. No automatic backlog,
// consent release, patient-wide exemption or rewrite of import receipts.
const fs = require('node:fs');
const runtime = require('./whatsappAuthorizedRuntime');
const operations = require('./whatsappImportedAppointmentOperations');
const FILE = runtime.ROOTS.staging + '/same-day-recovery-20261007.json';
const DAY = '2026-10-07';
const due = Date.parse('2026-10-07T06:00:00.000Z');
const end = Date.parse('2026-10-07T22:00:00.000Z');
const id = n => Number.isSafeInteger(n) && n > 0;
const instant = v => v == null ? NaN : new Date(v).getTime();
const day = v => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(v));
const object = v => typeof v === 'string' ? JSON.parse(v) : v || {};
let cache;
function validate(p) {
    if (!p || p.version !== 1 || p.purpose !== 'same_day_reminder_recovery' || p.date !== DAY
        || !id(p.approvedBy) || !/^[\w:-]{1,100}$/.test(p.approvalRef || '')
        || !Number.isFinite(instant(p.approvedAt)) || instant(p.approvedAt) < due
        || !Number.isFinite(instant(p.expiresAt)) || instant(p.expiresAt) <= instant(p.approvedAt)
        || instant(p.expiresAt) > end || p.automaticBacklogReplay !== false
        || !Array.isArray(p.appointments) || !p.appointments.length || p.appointments.length > 500) {
        throw Error('invalid_same_day_recovery');
    }
    const index = new Map(), patients = new Set();
    for (const a of p.appointments) {
        if (!id(a.id) || !id(a.patientId) || ![66,72].includes(a.clinicId)
            || a.templateVersionId !== ({ 66:1777, 72:1782 })[a.clinicId]
            || !Number.isFinite(instant(a.startAt)) || day(a.startAt) !== DAY
            || instant(a.startAt) <= instant(p.approvedAt)
            || a.sourceSystem !== 'cliniccloud' || typeof a.sourceReference !== 'string'
            || index.has(a.id) || patients.has(a.patientId)) throw Error('invalid_same_day_recovery');
        index.set(a.id, Object.freeze({ ...a })); patients.add(a.patientId);
    }
    return Object.freeze({ ...p, index });
}
function read(env = process.env) {
    if (env.WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE !== runtime.ROOTS.staging + '/config.json') return null;
    try {
        if (runtime.namespace(env) !== 'staging' || fs.realpathSync(FILE) !== FILE) return null;
        const stat = fs.statSync(FILE);
        if (!stat.isFile() || stat.mode & 0o077 || stat.size < 1 || stat.size > 262144) return null;
        const revision = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
        if (cache?.revision === revision) return cache.policy;
        const policy = validate(JSON.parse(fs.readFileSync(FILE, 'utf8')));
        cache = { revision, policy }; return policy;
    } catch { cache = null; return null; }
}
function allowsAppointment(appointment, { now = Date.now(), policy = read() } = {}) {
    const a = appointment?.toJSON ? appointment.toJSON() : appointment;
    if (!policy || now < instant(policy.approvedAt) || now >= instant(policy.expiresAt)
        || !a || operations.isHistorical(a)) return false;
    const item = policy.index.get(Number(a.id_cita));
    const m = object(a.import_metadata), suppression = object(m.notification_suppression);
    if (!item || Number(a.clinica_id) !== item.clinicId || Number(a.paciente_id) !== item.patientId
        || instant(a.inicio) !== instant(item.startAt) || instant(a.inicio) <= now
        || a.estado !== 'recordatorio_confirmado' || a.es_provisional
        || a.source_system !== item.sourceSystem || a.source_reference !== item.sourceReference
        || m.qa_demo || m.synthetic_data_only || m.notificationSuppression
        || m.cliniccloud_reconciliation?.automation_policy !== 'hold'
        || !Object.keys(suppression).length
        || Object.keys(suppression).some(k => !['same_day','day_before','appointment_details'].includes(k)
            || typeof suppression[k] !== 'boolean')) return false;
    return true;
}
function permits(appointment, { execution, templateName, now = Date.now(), policy = read() } = {}) {
    const a = appointment?.toJSON ? appointment.toJSON() : appointment;
    const e = execution?.toJSON ? execution.toJSON() : execution;
    if (!e || !allowsAppointment(a, { now, policy })
        || !/^clinicaclick_recordatorio_mismo_dia(?:_|$)/.test(templateName || '')) return false;
    const item = policy.index.get(Number(a.id_cita));
    if (Number(e.template_version_id) !== item.templateVersionId
        || e.trigger_type !== 'appointment_reminder_window' || e.trigger_entity_type !== 'appointment'
        || Number(e.trigger_entity_id) !== item.id || Number(e.clinic_id) !== item.clinicId
        || !Number.isFinite(instant(e.created_at)) || instant(e.created_at) < instant(policy.approvedAt)
        || instant(e.created_at) > now || instant(object(e.context).appointment?.inicio) !== instant(a.inicio)) return false;
    return true;
}
module.exports = { FILE, validate, read, allowsAppointment, permits };
