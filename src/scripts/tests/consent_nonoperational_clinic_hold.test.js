'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { assertClinicNonOperationalAllowed } = require('../../lib/whatsappAppointmentEligibility');
const servicePath = require.resolve('../../services/consentimientos.service');
const signature = { signer_name: 'Paciente ficticio QA', accepted_statement: true,
  signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' };

// All SQL/side effects are local doubles. Loading this service never imports the
// application models, real environment credentials, transport or a worker.
function harness(clinicId) {
  const Op = require('sequelize').Op;
  const state = { reads: 0, writes: [], tokens: [], transactions: 0 };
  const start = '2099-11-16T16:30:00Z';
  const appointment = { id_cita: 2, paciente_id: 3, clinica_id: clinicId, tratamiento_id: 5,
    estado: 'pendiente', inicio: start };
  const doc = { id: 6, package_id: 1, cita_id: 2, paciente_id: 3, clinica_id: clinicId,
    public_id: 'unit-document', status: 'pending', required: true, revoked_at: null,
    snapshot_json: {}, snapshot_hash: 'unit-original', snapshot_html: '<p>QA only</p>' };
  const pack = { id: 1, public_id: 'unit-package', cita_id: 2, paciente_id: 3, clinica_id: clinicId,
    tratamiento_id: 5, status: 'pending', expires_at: '2100-01-01', documents: [doc],
    tratamiento: { nombre: 'Tratamiento ficticio' }, paciente: { email: 'unit@example.invalid', telefono_movil: '34000000000' } };
  doc.update = async values => { state.writes.push(['document', values]); Object.assign(doc, values); };
  const db = { Sequelize: { Op }, Paciente: {}, Clinica: {}, Tratamiento: {},
    sequelize: { transaction: async (options, work) => {
      state.transactions++; return work({ LOCK: { UPDATE: 'UPDATE' } });
    } },
    CitaPaciente: { findByPk: async () => { state.reads++; return appointment; } },
    ConsentSignaturePackage: {
      findByPk: async () => { state.reads++; return pack; },
      update: async values => { state.writes.push(['package', values]); Object.assign(pack, values); return [1]; },
    },
    PatientConsentDocument: {
      findByPk: async () => doc, findAll: async () => [doc],
      update: async values => { await doc.update(values); return [1]; },
    },
    PatientIntakeRequest: { findOne: async () => null },
    ConsentDeliveryEvent: { findOne: async () => null,
      create: async values => { state.writes.push(['event', values]); return values; } },
  };
  const nativeRequire = createRequire(servicePath), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(servicePath, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(servicePath), Buffer, console,
    process: { env: { JWT_SECRET: 'fictitious-test-key', CONSENT_TABLET_BASE_URL: 'https://tablet.clinicaclick.com', RUNTIME_NAMESPACE: 'staging' } },
    require(name) {
      if (name === '../../models') return db;
      if (name === 'jsonwebtoken') return { sign: fields => { state.tokens.push(fields); return 'unit-only-token'; },
        decode: () => ({ exp: 4102444800 }) };
      return nativeRequire(name);
    },
  });
  return { state, pack, doc, appointment, service: module.exports,
    scope: { packageId: 1, appointmentId: 2, patientId: 3, clinicId, capturedStart: start } };
}
const unchanged = h => JSON.stringify({ pack: h.pack, appointment: h.appointment });
const held = error => error.code === 'whatsapp_appointment_nonoperational_clinic_held'
  && error.details?.reason_code === error.code && error.retryable === false && error.statusCode === 403;

test('central synchronous clinic guard is shared by transport and consent/review domains, without a marketing veto', () => {
  for (const clinicId of [66, 72]) {
    for (const purpose of ['consent', 'review_request']) assert.throws(() => assertClinicNonOperationalAllowed(clinicId,
      { metadata: { communication_purpose: purpose } }), held);
    assert.throws(() => assertClinicNonOperationalAllowed(clinicId, { execution: { trigger_type: 'consent_required' } }), held);
    assert.equal(assertClinicNonOperationalAllowed(clinicId, { metadata: { communication_scope: 'marketing' } }), true);
  }
  assert.equal(assertClinicNonOperationalAllowed(3, { metadata: { communication_purpose: 'consent' } }), true);
});

test('external mock email/WhatsApp and default channels are denied before any token, transaction or status write in BS clinics', async () => {
  for (const clinicId of [66, 72]) for (const channel of ['email', 'whatsapp', undefined, 'invalid']) {
    const h = harness(clinicId), before = unchanged(h);
    await assert.rejects(h.service.sendPackageMock(1, { channel, clinic_id: 3, clinica_id: 3,
      recipient: 'changed@example.invalid', communication_scope: 'care' }), held);
    assert.equal(unchanged(h), before); assert.equal(h.state.tokens.length, 0);
    assert.equal(h.state.writes.length, 0); assert.equal(h.state.transactions, 0);
  }
});

test('automation WhatsApp consent link preparation is denied after real scope validation, without minting a token or changing anything', async () => {
  for (const clinicId of [66, 72]) {
    const h = harness(clinicId), before = unchanged(h);
    await assert.rejects(h.service.prepareAutomationPackageContext({ ...h.scope,
      channel: 'tablet', internal: true, base_url: 'https://ignored.example.invalid' }), held);
    assert.equal(unchanged(h), before); assert.equal(h.state.tokens.length, 0);
    assert.equal(h.state.writes.length, 0); assert.equal(h.state.transactions, 0);
  }
});

test('automation scope is still authoritative and a forged non-BS caller clinic cannot obtain the BS package link', async () => {
  const h = harness(66), before = unchanged(h);
  await assert.rejects(h.service.prepareAutomationPackageContext({ ...h.scope, clinicId: 3 }),
    { code: 'consent_automation_scope_changed' });
  assert.equal(unchanged(h), before); assert.equal(h.state.tokens.length, 0); assert.equal(h.state.writes.length, 0);
});

test('other clinics retain external mock sending and read-only automation link preparation', async () => {
  for (const channel of ['email', 'whatsapp']) {
    const h = harness(3), result = await h.service.sendPackageMock(1, { channel, clinic_id: 66 });
    assert.equal(result.public_token, 'unit-only-token'); assert.equal(h.doc.status, 'sent');
    assert.equal(h.state.tokens[0].channel, channel); assert(h.state.writes.length > 0);
  }
  const h = harness(3), before = unchanged(h);
  const result = await h.service.prepareAutomationPackageContext(h.scope);
  assert.match(result.consentimiento.enlace_publico, /unit-only-token$/);
  assert.equal(h.state.tokens[0].channel, 'whatsapp'); assert.equal(unchanged(h), before);
  assert.equal(h.state.writes.length, 0);
});

test('BS tablet/internal mock delivery remains available for on-site work', async () => {
  for (const clinicId of [66, 72]) for (const channel of ['tablet', 'internal']) {
    const h = harness(clinicId), result = await h.service.sendPackageMock(1, { channel });
    assert.equal(result.public_token, 'unit-only-token'); assert.equal(h.state.tokens[0].channel, channel);
    assert.equal(h.doc.status, channel === 'tablet' ? 'viewed' : 'sent');
    assert(h.state.writes.length > 0);
  }
});

test('BS on-site tablet session creation is unchanged and only queues tablet delivery', async () => {
  for (const clinicId of [66, 72]) {
    const h = harness(clinicId), result = await h.service.createTabletSession(1);
    assert.equal(result.public_token, 'unit-only-token'); assert.equal(h.state.tokens[0].channel, 'tablet');
    const events = h.state.writes.filter(([name]) => name === 'event');
    assert.equal(events.length, 1); assert.equal(events[0][1].channel, 'tablet');
    assert.equal(events[0][1].status, 'queued'); assert.equal(h.doc.status, 'pending');
  }
});

test('BS in-clinic patient signature remains valid without issuing any outbound token', async () => {
  for (const clinicId of [66, 72]) {
    const h = harness(clinicId), result = await h.service.signConsentDocument('6', signature);
    assert.equal(result.status, 'signed'); assert.equal(h.doc.snapshot_json.signature_evidence.signer_name, signature.signer_name);
    assert.equal(h.state.tokens.length, 0); assert.equal(h.doc.snapshot_json.signature_evidence.method, 'tablet_signature');
  }
});
