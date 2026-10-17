'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { registrationDocuments, assertRegistrationDocumentsBeforeStart } = require('../../services/appointmentRegistrationDocuments.service');
const now = new Date('2026-10-17T10:00:00Z'), appointment = { id_cita: 9, paciente_id: 8, clinica_id: 7 };
function fixture({ required = true, purpose = 'other', templateStatus = 'active', documents = [], packages = [], deliveries = [], imported = [], prior = null, settings = {}, version = true } = {}) {
  const calls = [], transaction = { LOCK: { SHARE: 'SHARE' } }, Op = { in: Symbol('in'), ne: Symbol('ne'), lte: Symbol('lte'), or: Symbol('or') };
  const read = (name, value) => async (...args) => {
    const q = args.at(-1); calls.push([name, q]); assert.equal(q.transaction, transaction); return value;
  };
  const db = { Sequelize: { Op },
    Clinica: { findByPk: read('clinic', { id_clinica: 7, configuracion: { patient_intake: {
      additional_documents: [{ template_id: 6, required, sort_order: 0 }], ...settings } } }) },
    Paciente: { findByPk: read('patient', { id_paciente: 8, clinica_id: 7 }) },
    PatientCustomField: { findAll: read('imported', imported) }, CitaPaciente: { findOne: read('prior', prior) },
    ClinicConsentTemplate: { findAll: read('templates', [{ id: 6, clinic_id: 7, purpose, name: 'Documento de prueba', status: templateStatus, validity_mode: 'manual' }]) },
    ClinicConsentTemplateVersion: { findAll: read('versions', version ? [{ id: 5, clinic_template_id: 6, title: 'Documento adicional', status: 'published', body_html: '<p>Texto</p>' }] : []) },
    PatientConsentDocument: { findAll: read('documents', documents) }, ConsentSignaturePackage: { findAll: read('packages', packages) },
    ConsentDeliveryEvent: { findAll: read('deliveries', deliveries) },
  };
  return { db, calls, transaction, run: extra => registrationDocuments({ db, appointment, transaction, now, ...extra }),
    gate: extra => assertRegistrationDocumentsBeforeStart({ db, appointment, transaction, now, ...extra }) };
}
const signed = { id: 4, package_id: 3, paciente_id: 8, clinica_id: 7, clinic_template_id: 6, clinic_template_version_id: 5,
  purpose: 'other', status: 'signed', signed_at: '2026-10-16T10:00:00Z' };
test('read-only rows show not requested; exact first-care hard requirement blocks without writes', async () => {
  const f = fixture(), result = await f.run();
  assert.deepEqual(result.items, [{ template_id: 6, title: 'Documento adicional', required: true, state: 'not_requested' }]);
  assert.equal(result.required_before_first_care, true);
  await assert.rejects(f.gate(), error => error.code === 'appointment_intake_documents_required'
    && error.details.action === 'prepare_registration_documents' && error.details.template_ids[0] === 6);
  assert(f.calls.every(([, q]) => q.transaction === f.transaction));
  assert(f.calls.filter(([name]) => ['clinic', 'patient', 'imported', 'prior', 'templates', 'versions', 'documents'].includes(name)).length > 0);
});
test('signed current extra satisfies only its configured source and validity, not future/revoked/expired signatures', async () => {
  assert.equal((await fixture({ documents: [signed] }).gate()).items[0].state, 'signed');
  for (const patch of [{ status: 'pending' }, { signed_at: null }, { signed_at: '2027-01-01' }, { revoked_at: now },
    { expires_at: now }, { clinic_template_version_id: 2 }, { purpose: 'clinical' }, { paciente_id: 88 }, { clinica_id: 77 }]) {
    await assert.rejects(fixture({ documents: [{ ...signed, ...patch }] }).gate(), { code: 'appointment_intake_documents_required' });
  }
});
test('pending/sent/viewed follow live package and explicit delivery; expired or cancelled packages do not qualify', async () => {
  const doc = { ...signed, status: 'pending', signed_at: null }, pkg = { id: 3, paciente_id: 8, clinica_id: 7, status: 'pending' };
  assert.equal((await fixture({ documents: [doc], packages: [pkg] }).run()).items[0].state, 'pending');
  assert.equal((await fixture({ documents: [doc], packages: [pkg], deliveries: [{ patient_consent_document_id: 4, status: 'sent' }] }).run()).items[0].state, 'sent');
  assert.equal((await fixture({ documents: [doc], packages: [pkg], deliveries: [{ patient_consent_document_id: 4, status: 'viewed' }] }).run()).items[0].state, 'viewed');
  for (const patch of [{ status: 'cancelled' }, { status: 'expired' }, { expires_at: now }]) {
    assert.equal((await fixture({ documents: [doc], packages: [{ ...pkg, ...patch }] }).run()).items[0].state, 'not_requested');
  }
});
test('optional extra and commercial/image documents never gate care, even with a historical required checkbox', async () => {
  const optional = fixture({ required: false, version: false });
  assert.equal((await optional.gate()).items.length, 0, 'An unpublished optional extra cannot block care');
  assert.equal(optional.calls.length, 1);
  for (const purpose of ['commercial_communications', 'marketing_image']) {
    const f = fixture({ purpose, version: false });
    assert.equal((await f.gate()).items.length, 0);
    assert(!f.calls.some(([name]) => name === 'versions'));
    assert.equal((await fixture({ purpose, version: false, templateStatus: 'inactive' }).gate()).items.length, 0,
      'Even a retired marketing document cannot become a clinical condition');
  }
});
test('imported/prior-care patients and explicit first-care opt-out retain their existing care flow', async () => {
  for (const options of [{ imported: [{ value: '1075' }] }, { prior: { id_cita: 2 } }, { settings: { privacy_before_first_care: false } }]) {
    const f = fixture({ ...options, version: false });
    assert.equal((await f.gate()).required_before_first_care, false);
    assert(!f.calls.some(([name]) => name === 'templates'));
  }
});
test('hard missing publication fails closed and care checks run before any clinical/state mutation', async () => {
  await assert.rejects(fixture({ version: false }).gate(), { code: 'intake_additional_document_unavailable' });
  const source = fs.readFileSync(require.resolve('../../services/appointmentCare.service'), 'utf8');
  const gate = source.indexOf('assertRegistrationDocumentsBeforeStart(');
  assert(gate > source.indexOf('assertPrivacyBeforeStart('));
  assert(gate < source.indexOf('assessAppointmentClinicalConsent({'));
  assert(gate < source.indexOf('await cita.update('));
});
