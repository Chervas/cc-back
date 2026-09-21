'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessClinicalConsentEvidence: assess, assessAppointmentClinicalConsent: assessDb,
  assertClinicalCompletion } = require('../../services/appointmentConsentEligibility.service');
const now = new Date('2026-09-21T08:00:00Z');
const appointment = { id_cita: 11, paciente_id: 2, clinica_id: 3, tratamiento_id: 4, estado: 'completada' };
const template = { id: 5, purpose: 'clinical', status: 'active', validity_mode: 'per_treatment', requires_professional_signature: false };
const requirement = { id: 6, tratamiento_id: 4, clinic_template_id: 5, required: true, blocking_policy: 'hard', clinicTemplate: template };
const signed = { id: 7, paciente_id: 2, clinica_id: 3, tratamiento_id: 4, cita_id: 11, clinic_template_id: 5,
  purpose: 'clinical', status: 'signed', signed_at: '2026-09-21T07:00:00Z' };
const decision = (documents = [], requirements = [requirement]) => assess({ appointment, requirements, documents, now });

test('explicit hard clinical consent requires a valid signature for this act', () => {
  assert.deepEqual(decision(), { allowed: false, blocking_count: 1, required_clinical_count: 1 });
  assert.equal(decision([signed]).allowed, true);
});
for (const status of ['pending', 'sent', 'viewed', 'rejected', 'revoked', 'expired', 'cancelled', 'superseded', 'voided']) {
  test(`status ${status} never constitutes clinical consent`, () => assert.equal(decision([{ ...signed, status }]).allowed, false));
}
for (const [label, change] of [
  ['wrong patient', { paciente_id: 9 }], ['wrong clinic', { clinica_id: 9 }], ['wrong treatment', { tratamiento_id: 9 }],
  ['wrong act', { cita_id: 9 }], ['wrong template', { clinic_template_id: 9 }], ['marketing', { purpose: 'marketing' }],
  ['missing signature date', { signed_at: null }], ['invalid date', { signed_at: 'invalid' }],
  ['future signature', { signed_at: '2026-09-22' }], ['revoked signature', { revoked_at: '2026-09-20' }],
  ['expired signature', { expires_at: now }], ['invalid expiry', { expires_at: 'invalid' }],
]) test(label + ' cannot satisfy the requirement', () => assert.equal(decision([{ ...signed, ...change }]).allowed, false));

test('manual validity permits reuse, but still validates expiry and clinic', () => {
  const requirements = [{ ...requirement, clinicTemplate: { ...template, validity_mode: 'manual' } }];
  assert.equal(decision([{ ...signed, cita_id: 9, tratamiento_id: 8 }], requirements).allowed, true);
  assert.equal(decision([{ ...signed, cita_id: 9, expires_at: now }], requirements).allowed, false);
  assert.equal(decision([{ ...signed, cita_id: 9, clinica_id: 8 }], requirements).allowed, false);
});
test('optional, soft and nonclinical documentation never blocks receiving clinical care', () => {
  for (const change of [{ required: false }, { blocking_policy: 'soft' }, { blocking_policy: 'optional' },
    { clinicTemplate: { ...template, purpose: 'marketing' } }, { clinicTemplate: { ...template, purpose: 'data_protection' } }]) {
    assert.deepEqual(decision([], [{ ...requirement, ...change }]), { allowed: true, blocking_count: 0, required_clinical_count: 0 });
  }
});
test('professional signature is checked against the signed snapshot', () => {
  const requirements = [{ ...requirement, clinicTemplate: { ...template, requires_professional_signature: true } }];
  assert.equal(decision([signed], requirements).allowed, false);
  assert.equal(decision([{ ...signed, professional_signed_by: 1, professional_signed_at: '2026-09-21T07:30:00Z' }], requirements).allowed, true);
  assert.equal(decision([{ ...signed, professional_signed_by: 1, professional_signed_at: '2026-09-22' }], requirements).allowed, false);
  assert.equal(decision([{ ...signed, snapshot_json: { template: { requires_professional_signature: false } } }], requirements).allowed, true);
  assert.equal(decision([{ ...signed, snapshot_json: { template: { requires_professional_signature: true } } }]).allowed, false);
});
test('dangling clinical requirement fails closed; archived templates cannot authorize new acts', () => {
  assert.throws(() => decision([], [{ ...requirement, clinicTemplate: null }]), { code: 'appointment_consent_configuration_required' });
  assert.equal(decision([signed], [{ ...requirement, clinicTemplate: { ...template, status: 'archived' } }]).allowed, false);
});
test('duplicate requirements and rejected attempts do not obscure a valid signed document', () => {
  assert.deepEqual(decision([{ ...signed, status: 'rejected' }, signed], [requirement, requirement]),
    { allowed: true, blocking_count: 0, required_clinical_count: 1 });
});
test('catalog templates have their own namespace', () => {
  const catalogRequirement = { ...requirement, clinic_template_id: null, clinicTemplate: null, catalog_template_id: 5, catalogTemplate: template };
  assert.equal(decision([signed], [catalogRequirement]).allowed, false);
  assert.equal(decision([{ ...signed, clinic_template_id: null, catalog_template_id: 5 }], [catalogRequirement]).allowed, true);
});

function databaseFixture() {
  const calls = [];
  const transaction = { LOCK: { SHARE: 'SHARE' } };
  const Op = { in: Symbol('in'), or: Symbol('or') };
  const db = { Sequelize: { Op }, ClinicConsentTemplate: {}, ConsentTemplateCatalog: {},
    TreatmentConsentRequirement: { findAll: async options => { calls.push(['requirements', options]); return [requirement]; } },
    PatientConsentDocument: { findAll: async options => { calls.push(['documents', options]); return []; } },
  };
  return { db, calls, transaction, Op };
}
test('completion evidence reads are bounded, tenant scoped and locked in the write transaction', async () => {
  const f = databaseFixture();
  assert.equal((await assessDb({ ...f, appointment, now })).allowed, false);
  assert.equal(f.calls.length, 2);
  for (const [, query] of f.calls) { assert.equal(query.transaction, f.transaction); assert.equal(query.lock, 'SHARE'); assert(query.limit <= 1001); }
  assert.equal(f.calls[1][1].where.paciente_id, 2); assert.equal(f.calls[1][1].where.clinica_id, 3);
  assert.deepEqual(f.calls[0][1].where[f.Op.or], [{ clinica_id: 3 }, { clinica_id: null }]);
});
test('book, cancel, replay and history drafts do not invoke the clinical completion check', async () => {
  const f = databaseFixture();
  for (const estado of ['pendiente', 'confirmada', 'cancelada', 'no_asistio', 'reprogramada']) {
    await assertClinicalCompletion({ ...f, appointment: { ...appointment, estado } });
  }
  await assertClinicalCompletion({ ...f, appointment, previous: appointment });
  assert.equal(f.calls.length, 0);
});
test('unsigned completion fails with an actionable, non-forceable 409 without clinical identifiers', async () => {
  const f = databaseFixture();
  await assert.rejects(assertClinicalCompletion({ ...f, appointment, now }), error => {
    assert.equal(error.statusCode, 409); assert.equal(error.code, 'appointment_consent_required');
    assert.deepEqual(error.details, { action: 'review_consents', blocking_count: 1 }); return true;
  });
});
test('all purchased program phase treatments are checked using the canonical session ledger', async () => {
  const f = databaseFixture();
  f.db.PatientVoucher = { findOne: async options => { assert.equal(options.where.patient_id, 2); return { id: 8 }; } };
  f.db.PatientProgramSession = { findOne: async options => { assert.equal(options.where.appointment_id, 11); return { snapshot: { treatment_ids: [4, 9] } }; } };
  f.db.TreatmentConsentRequirement.findAll = async options => {
    assert.deepEqual(options.where.tratamiento_id[f.Op.in], [4, 9]); return [requirement, { ...requirement, tratamiento_id: 9 }];
  };
  f.db.PatientConsentDocument.findAll = async () => [signed];
  const result = await assessDb({ ...f, appointment: { ...appointment, source_system: 'treatment_program', voucher_id: 8 }, now });
  assert.deepEqual(result, { allowed: false, blocking_count: 1, required_clinical_count: 2 });
});
test('missing transactions and missing canonical program composition fail closed', async () => {
  const f = databaseFixture();
  await assert.rejects(assessDb({ db: f.db, appointment }), /consent_completion_transaction_required/);
  f.db.PatientVoucher = { findOne: async () => null };
  await assert.rejects(assessDb({ ...f, appointment: { ...appointment, source_system: 'treatment_program', voucher_id: 8 } }), { code: 'program_session_not_found' });
});
