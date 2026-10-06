'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { assertConsentAutomationScope, assertConsentAutomationConfiguration } = require('../../lib/consent-automation-link');

const now = Date.parse('2026-10-06T14:00:00Z');
const start = '2099-11-16T16:30:00Z';
function fixture() {
  return {
    now,
    scope: { packageId: 1, appointmentId: 2, patientId: 3, clinicId: 4, capturedStart: start },
    appointment: { id_cita: 2, paciente_id: 3, clinica_id: 4, tratamiento_id: 5, estado: 'pendiente', inicio: start },
    packageRow: { id: 1, public_id: 'cpkg_fictitious', cita_id: 2, paciente_id: 3, clinica_id: 4,
      tratamiento_id: 5, status: 'pending', expires_at: '2100-01-01', tratamiento: { nombre: 'Tratamiento ficticio' },
      documents: [{ id: 6, package_id: 1, cita_id: 2, paciente_id: 3, clinica_id: 4, status: 'pending' }] },
  };
}

test('a present package/appointment/documents proof permits read-only link preparation', () => {
  const data = fixture();
  assert.deepEqual(assertConsentAutomationScope(data), data.packageRow.documents);
});
for (const [label, mutate] of [
  ['missing scope', f => f.scope = {}],
  ['wrong patient', f => f.scope.patientId = 9],
  ['wrong clinic', f => f.scope.clinicId = 9],
  ['wrong appointment', f => f.scope.appointmentId = 9],
  ['wrong package', f => f.scope.packageId = 9],
  ['changed treatment', f => f.appointment.tratamiento_id = 9],
  ['package not for appointment', f => f.packageRow.cita_id = null],
]) test(label + ' fails closed', () => {
  const data = fixture(); mutate(data);
  assert.throws(() => assertConsentAutomationScope(data), { code: 'consent_automation_scope_changed' });
});
for (const estado of ['cancelada', 'completada', 'no_asistio']) test('no send after appointment ' + estado, () => {
  const data = fixture(); data.appointment.estado = estado;
  assert.throws(() => assertConsentAutomationScope(data), { code: 'consent_automation_appointment_ineligible' });
});
for (const [label, mutate] of [
  ['past appointment', f => f.appointment.inicio = '2026-10-06T13:00:00Z'],
  ['rescheduled since capture', f => f.scope.capturedStart = '2099-11-17T16:30:00Z'],
  ['provisional appointment', f => f.appointment.es_provisional = true],
]) test(label + ' prevents obsolete consent dispatch', () => {
  const data = fixture(); mutate(data);
  assert.throws(() => assertConsentAutomationScope(data), { code: 'consent_automation_appointment_ineligible' });
});
for (const [label, mutate] of [
  ['expired package', f => f.packageRow.expires_at = '2026-10-01'],
  ['invalid package expiry', f => f.packageRow.expires_at = 'invalid'],
  ['cancelled package', f => f.packageRow.status = 'cancelled'],
  ['signed package', f => f.packageRow.status = 'signed'],
]) test(label + ' is not revived', () => {
  const data = fixture(); mutate(data);
  assert.throws(() => assertConsentAutomationScope(data), { code: 'consent_package_unavailable' });
});
for (const [label, mutate] of [
  ['signed document', d => d.status = 'signed'],
  ['expired document', d => d.expires_at = '2026-10-01'],
  ['revoked document', d => d.revoked_at = '2026-10-01'],
  ['wrong document owner', d => d.paciente_id = 9],
  ['wrong document clinic', d => d.clinica_id = 9],
  ['wrong document appointment', d => d.cita_id = 9],
]) test(label + ' does not become pending for recovery', () => {
  const data = fixture(); mutate(data.packageRow.documents[0]);
  assert.throws(() => assertConsentAutomationScope(data), { code: 'consent_package_has_no_pending_documents' });
});
test('an expired sibling does not prevent the remaining eligible document, or mutate it', () => {
  const data = fixture();
  const original = structuredClone(data);
  data.packageRow.documents.push({ ...data.packageRow.documents[0], id: 7, expires_at: '2026-10-01' });
  assert.deepEqual(assertConsentAutomationScope(data), original.packageRow.documents);
  assert.equal(data.packageRow.documents[1].expires_at, '2026-10-01');
});

test('canonical production URL and explicit isolated DEV origins are accepted', () => {
  assert.equal(assertConsentAutomationConfiguration({ baseUrl: 'https://tablet.clinicaclick.com/', secretConfigured: true, runtimeNamespace: 'staging' }), 'https://tablet.clinicaclick.com');
  assert.equal(assertConsentAutomationConfiguration({ baseUrl: 'http://localhost:4203', secretConfigured: true, runtimeNamespace: 'dev' }), 'http://localhost:4203');
});
for (const baseUrl of ['javascript:alert(1)', 'https://evil.example', 'http://tablet.clinicaclick.com',
  'https://tablet.clinicaclick.com.evil.example', 'https://user:pass@tablet.clinicaclick.com',
  'https://tablet.clinicaclick.com/?next=https://evil.example', 'https://tablet.clinicaclick.com/#bad',
  'https://tablet.clinicaclick.com/injected', 'http://localhost:4203']) {
  test('reject a bad/staging-local signing origin: ' + baseUrl, () => {
    assert.throws(() => assertConsentAutomationConfiguration({ baseUrl, secretConfigured: true, runtimeNamespace: 'staging' }), { code: 'consent_automation_public_url_invalid' });
  });
}
test('automation cannot use an absent/default JWT configuration', () => {
  assert.throws(() => assertConsentAutomationConfiguration({ baseUrl: 'https://tablet.clinicaclick.com', secretConfigured: false }), { code: 'consent_automation_signing_not_configured' });
});

function serviceHarness({ env = {}, change = () => {} } = {}) {
  const data = fixture(); change(data);
  let writes = 0;
  const db = { Sequelize: { Op: {} },
    CitaPaciente: { findByPk: async () => data.appointment },
    ConsentSignaturePackage: { findByPk: async () => data.packageRow, update: async () => { writes++; } },
    PatientConsentDocument: { update: async () => { writes++; } },
    ConsentDeliveryEvent: { create: async () => { writes++; } },
  };
  const servicePath = require.resolve('../../services/consentimientos.service');
  const nativeRequire = createRequire(servicePath), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(servicePath, 'utf8'), {
    require: name => name === '../../models' ? db : nativeRequire(name),
    module, exports: module.exports, __dirname: path.dirname(servicePath), Buffer, console,
    process: { env: { JWT_SECRET: 'fictitious-unit-test-signing-key', CONSENT_TABLET_BASE_URL: 'https://tablet.clinicaclick.com', RUNTIME_NAMESPACE: 'staging', ...env } },
  });
  return { data, service: module.exports, writes: () => writes };
}
test('uses existing public token contract and route without marking anything sent', async () => {
  const h = serviceHarness();
  const before = structuredClone(h.data);
  const result = await h.service.prepareAutomationPackageContext(h.data.scope);
  const url = new URL(result.consentimiento.enlace_publico);
  assert.equal(url.origin, 'https://tablet.clinicaclick.com');
  assert.equal(url.pathname.split('/').slice(0, 3).join('/'), '/tablet/consentimientos');
  const token = decodeURIComponent(url.pathname.split('/')[3]);
  const payload = createRequire(require.resolve('../../services/consentimientos.service'))('jsonwebtoken')
    .verify(token, 'fictitious-unit-test-signing-key');
  assert.equal(payload.type, 'consent_signature_package');
  assert.equal(payload.package_id, 1); assert.equal(payload.package_public_id, 'cpkg_fictitious');
  assert.equal(payload.channel, 'whatsapp');
  assert.equal(result.tratamiento.nombre, 'Tratamiento ficticio');
  assert.equal(h.writes(), 0); assert.deepEqual(h.data, before);
});
for (const JWT_SECRET of ['', '   ', 'clinicaclick-dev-consentimientos']) test('service rejects unsafe configured signing key: ' + JSON.stringify(JWT_SECRET), async () => {
  const h = serviceHarness({ env: { JWT_SECRET } });
  await assert.rejects(h.service.prepareAutomationPackageContext(h.data.scope), { code: 'consent_automation_signing_not_configured' });
  assert.equal(h.writes(), 0);
});
test('service never trusts a caller URL override', async () => {
  const h = serviceHarness();
  const result = await h.service.prepareAutomationPackageContext({ ...h.data.scope, base_url: 'https://evil.example' });
  assert.equal(new URL(result.consentimiento.enlace_publico).origin, 'https://tablet.clinicaclick.com');
  assert.equal(h.writes(), 0);
});

test('engine enriches only a verified consent trigger, ignoring prefilled patient links', async () => {
  const servicePath = require.resolve('../../services/flowEngineV2.service');
  const source = fs.readFileSync(servicePath, 'utf8');
  const from = source.indexOf('async function enrichContextForTemplateResolution(');
  const to = source.indexOf('\nfunction buildExecutionSocketPayload', from);
  const calls = [];
  const h = serviceHarness();
  const sandbox = {
    clone: value => JSON.parse(JSON.stringify(value)),
    toIntOrNull: value => Number(value) > 0 ? Number(value) : null,
    cleanString: value => value == null ? '' : String(value).trim(),
    CitaPaciente: { findByPk: async () => h.data.appointment },
    Usuario: { findByPk: async () => null }, Clinica: { findByPk: async () => null },
    db: { Paciente: { findByPk: async () => null } },
    mergeContextObject: (a, b) => ({ ...a, ...b }), formatAppointmentLocalDateTime: () => ({}),
    require: name => { assert.equal(name, './consentimientos.service'); return { prepareAutomationPackageContext: async scope => { calls.push(scope); return h.service.prepareAutomationPackageContext(scope); } }; },
  };
  vm.runInNewContext(source.slice(from, to), sandbox);
  const context = { trigger: { type: 'consent_required', data: { consent_package_id: 1, inicio: start } },
    appointment: { inicio: start }, consentimiento: { enlace_publico: 'https://evil.example' } };
  const targets = { appointment_id: 2, patient_id: 3, clinic_id: 4 };
  const result = await sandbox.enrichContextForTemplateResolution(context, targets, { includeConsentLink: true });
  assert.equal(new URL(result.consentimiento.enlace_publico).origin, 'https://tablet.clinicaclick.com');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].capturedStart, start);
  assert.equal(result.tratamiento.nombre, 'Tratamiento ficticio');
  await sandbox.enrichContextForTemplateResolution({ trigger: { type: 'appointment_created' } }, targets, { includeConsentLink: true });
  await sandbox.enrichContextForTemplateResolution(context, targets);
  assert.equal(calls.length, 1);
  assert.equal(h.writes(), 0);
});
