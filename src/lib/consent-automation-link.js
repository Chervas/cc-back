'use strict';

const pending = new Set(['pending', 'sent', 'viewed']);
const activeAppointment = new Set(['pendiente', 'info_enviada', 'info_confirmada',
  'recordatorio_enviado', 'recordatorio_confirmado', 'reprogramada']);
const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const time = value => value == null ? NaN : new Date(value).getTime();
const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };

// The trigger supplies only an identifier, never a URL/token or a clinical
// snapshot. Ownership and present eligibility must be established from SQL.
function assertConsentAutomationScope({ packageRow: pack, appointment: app, scope, now = Date.now() }) {
  if (!pack || !app || !id(scope?.packageId) || !id(scope?.appointmentId)
    || !id(scope?.clinicId) || !id(scope?.patientId)
    || id(pack.id) !== id(scope.packageId) || id(app.id_cita) !== id(scope.appointmentId)
    || id(pack.cita_id) !== id(app.id_cita) || id(pack.clinica_id) !== id(scope.clinicId)
    || id(app.clinica_id) !== id(scope.clinicId) || id(pack.paciente_id) !== id(scope.patientId)
    || id(app.paciente_id) !== id(scope.patientId)
    || !id(app.tratamiento_id) || id(pack.tratamiento_id) !== id(app.tratamiento_id)) {
    fail('consent_automation_scope_changed');
  }
  if (!activeAppointment.has(app.estado) || app.es_provisional || !Number.isFinite(time(app.inicio))
    || time(app.inicio) <= now || (scope.capturedStart != null && time(scope.capturedStart) !== time(app.inicio))) {
    fail('consent_automation_appointment_ineligible');
  }
  if (!pending.has(pack.status) || pack.expires_at != null
    && (!Number.isFinite(time(pack.expires_at)) || time(pack.expires_at) <= now)) {
    fail('consent_package_unavailable');
  }
  const documents = (Array.isArray(pack.documents) ? pack.documents : []).filter(doc =>
    pending.has(doc.status) && !doc.revoked_at && id(doc.package_id) === id(pack.id)
    && id(doc.paciente_id) === id(scope.patientId) && id(doc.clinica_id) === id(scope.clinicId)
    && id(doc.cita_id) === id(scope.appointmentId)
    && (doc.expires_at == null || Number.isFinite(time(doc.expires_at)) && time(doc.expires_at) > now));
  if (!documents.length) fail('consent_package_has_no_pending_documents');
  return documents;
}

function assertConsentAutomationConfiguration({ baseUrl, secretConfigured, runtimeNamespace }) {
  if (!secretConfigured) fail('consent_automation_signing_not_configured');
  let url;
  try { url = new URL(baseUrl); } catch { fail('consent_automation_public_url_invalid'); }
  const isolatedDev = runtimeNamespace === 'dev';
  const allowed = url.origin === 'https://tablet.clinicaclick.com'
    || isolatedDev && ['http://localhost:4203', 'http://127.0.0.1:4203'].includes(url.origin);
  if (!allowed || url.username || url.password || url.search || url.hash
    || !['', '/'].includes(url.pathname)) fail('consent_automation_public_url_invalid');
  return url.origin;
}

module.exports = { assertConsentAutomationScope, assertConsentAutomationConfiguration };
