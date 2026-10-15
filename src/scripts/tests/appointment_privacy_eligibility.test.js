'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { assessPrivacyBeforeStart: assess, assertPrivacyBeforeStart: enforce, FINAL_PRIVACY_KEY } = require('../../services/appointmentPrivacyEligibility.service');
const { CHOICE_SCHEMA_VERSION, CHOICE_HASH_ALGORITHM, CHOICE_KEYS, CHOICE_LABELS, choiceSnapshotHash } = require('../../lib/consent-document-choices');
const now = new Date('2026-10-15T12:00:00Z');
const appointment = { id_cita: 11, paciente_id: 2, clinica_id: 72, tratamiento_id: null };
const form = { schema_version: CHOICE_SCHEMA_VERSION, fields: CHOICE_KEYS.map(key => ({ key, label: CHOICE_LABELS[key], type: 'yes_no', required: true })) };
const template = { id: 600, clinic_id: 72, catalog_key: FINAL_PRIVACY_KEY, purpose: 'data_protection', status: 'active', is_default: true, blocking_policy: 'hard', requires_professional_signature: false };
const version = { id: 700, body_html: '<p>LOPD final</p>', body_json: { consent_form: form } };
const signed = { id: 800, paciente_id: 2, clinica_id: 72, clinic_template_id: 600, clinic_template_version_id: 700,
  purpose: 'data_protection', status: 'signed', signed_at: '2026-10-15T11:00:00Z', snapshot_html: '<p>LOPD final firmada</p>', snapshot_json: {
    integrity: { algorithm: CHOICE_HASH_ALGORITHM },
    template, version: { id: 700, body_json: { consent_form: form } },
    signature_evidence: { accepted_statement: true, signed_at: '2026-10-15T11:00:00Z',
      consent_choices: { schema_version: CHOICE_SCHEMA_VERSION, answers: Object.fromEntries(CHOICE_KEYS.map(key => [key, 'no'])) } },
  } };
signed.snapshot_hash = choiceSnapshotHash(signed.snapshot_json, signed.snapshot_html);
function fixture({ imported = null, prior = null, documents = [], currentTemplate = template, currentVersion = version } = {}) {
  const calls = [], transaction = { LOCK: { SHARE: 'SHARE' } }, Op = { ne: Symbol('ne'), lte: Symbol('lte'), or: Symbol('or'), in: Symbol('in') };
  const reader = (name, value) => ({ findOne: async options => { calls.push([name, options]); assert.equal(options.transaction, transaction); assert.equal(options.lock, 'SHARE'); return value; } });
  const db = { Sequelize: { Op }, Paciente: { findByPk: async (_id, q) => { assert.equal(q.lock, 'SHARE'); return { id_paciente: 2, clinica_id: 72 }; } },
    PatientCustomField: { findAll: async options => { calls.push(['imported', options]); assert.equal(options.transaction, transaction); assert.equal(options.lock, 'SHARE'); return Array.isArray(imported) ? imported : imported ? [imported] : []; } }, CitaPaciente: reader('prior_care', prior),
    ClinicConsentTemplate: reader('template', currentTemplate), ClinicConsentTemplateVersion: reader('version', currentVersion),
    PatientConsentDocument: { findAll: async q => { calls.push(['documents', q]); assert.equal(q.transaction, transaction); assert.equal(q.lock, 'SHARE'); assert.equal(q.limit, 101); return documents; } },
  };
  return { db, transaction, calls, run: extra => assess({ db, transaction, appointment, now, ...extra }), enforce: extra => enforce({ db, transaction, appointment, now, ...extra }) };
}
test('first native care is blocked without current privacy even without a treatment', async () => {
  const f = fixture(); assert.deepEqual(await f.run(), { required: true, allowed: false, reason: 'current_privacy_pending' });
  await assert.rejects(f.enforce(), { code: 'appointment_consent_privacy_required', statusCode: 409 });
  const q = f.calls.find(([name]) => name === 'template')[1]; assert.equal(q.where.catalog_key, FINAL_PRIVACY_KEY);
  assert.equal(q.where.is_default, true); assert.equal(q.where.blocking_policy, 'hard');
});
test('a valid current signed notice with four No answers permits care, not marketing', async () => {
  const f = fixture({ documents: [signed] });
  assert.deepEqual(await f.enforce(), { required: true, allowed: true, reason: 'current_privacy_signed' });
  assert(f.calls.every(([name]) => ['imported', 'prior_care', 'template', 'version', 'documents'].includes(name)));
});
test('other clinics keep their existing policy without touching models', async () => {
  assert.deepEqual(await assess({ db: {}, appointment: { ...appointment, clinica_id: 3 } }), { required: false, allowed: true, reason: 'outside_registration_scope' });
});
test('existing imported provenance and real prior care are not forced to re-sign', async () => {
  assert.equal((await fixture({ imported: { value: '1075' } }).run()).reason, 'existing_imported_patient');
  assert.equal((await fixture({ prior: { id_cita: 10 } }).run()).reason, 'existing_clinical_patient');
  assert.equal((await fixture({ imported: { value: 'not a source contact id' } }).run()).required, true);
  const suffix = fixture({ imported: [{ field_key: 'cliniccloud_source_contact_id:1075', value: '1075' }] });
  assert.equal((await suffix.run()).reason, 'existing_imported_patient');
  const query = suffix.calls.find(([name]) => name === 'imported')[1];
  assert.equal(query.where.source_column, 'idContacto'); assert.equal(query.where.field_key, undefined);
});
test('new registration never falls back to retired templates or an empty/unpublished new version', async () => {
  for (const options of [{ currentTemplate: null }, { currentVersion: null }, { currentVersion: { ...version, body_html: '' } },
    { currentVersion: { ...version, body_json: {} } }]) await assert.rejects(fixture(options).run(), { code: 'appointment_consent_privacy_configuration' });
});
for (const [label, patch] of [
  ['old template', { clinic_template_id: 2 }], ['old version', { clinic_template_version_id: 312 }],
  ['other clinic', { clinica_id: 66 }], ['another patient', { paciente_id: 3 }], ['not privacy', { purpose: 'clinical' }],
  ['expired', { expires_at: now }], ['revoked', { revoked_at: now }], ['pending', { status: 'pending' }],
  ['future signature', { signed_at: '2026-10-16T00:00:00Z' }], ['empty choices', { snapshot_json: { template, version } }],
  ['malformed snapshot', { snapshot_json: 'not json' }],
  ['unknown integrity algorithm', { snapshot_json: { ...signed.snapshot_json, integrity: { algorithm: 'forged' } } }],
  ['missing integrity receipt', { snapshot_hash: null }], ['altered signed content', { snapshot_html: '<p>Alterado</p>' }],
]) test(label + ' cannot authorize first care', async () => assert.equal((await fixture({ documents: [{ ...signed, ...patch }] }).run()).allowed, false));
test('all reads are patient and clinic scoped and remain inside the care transaction', async () => {
  const f = fixture(); await f.run();
  const q = f.calls.find(([name]) => name === 'documents')[1]; assert.equal(q.where.paciente_id, 2); assert.equal(q.where.clinica_id, 72);
  assert.equal(q.where.clinic_template_id, 600); assert.equal(q.where.clinic_template_version_id, 700);
  await assert.rejects(f.run({ transaction: null }), { code: 'appointment_consent_privacy_configuration' });
});
test('canonical care start checks privacy before clinical requirements, documentation and appointment writes', () => {
  const source = fs.readFileSync(require.resolve('../../services/appointmentCare.service'), 'utf8');
  const privacy = source.indexOf('assertPrivacyBeforeStart(');
  assert(privacy > source.indexOf("if (action === 'start')"));
  assert(privacy < source.indexOf('assessAppointmentClinicalConsent({'));
  assert(privacy < source.indexOf('captureForStart({'));
  assert(privacy < source.indexOf('await cita.update('));
});
