'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { attach } = require('../../services/appointmentCardIndicators.service');
const Sequelize = require('sequelize');
const appointment = (id = 1) => ({ id_cita: id, paciente_id: 2, clinica_id: 3, tratamiento_id: 4 });
function fake(documents, requirements) {
  const calls = []; return { calls, Sequelize, ClinicConsentTemplate: {}, ConsentTemplateCatalog: {},
    TreatmentConsentRequirement: { findAll: async args => { calls.push(['requirements', args]); return requirements || [{ tratamiento_id: 4, clinica_id: 3, clinic_template_id: 5, clinicTemplate: { status: 'active', validity_mode: 'manual' } }]; } },
    PatientConsentDocument: { findAll: async args => { calls.push(['documents', args]); return documents; } } };
}
const signed = () => ({ paciente_id: 2, clinica_id: 3, clinic_template_id: 5, status: 'signed', signed_at: new Date(), requires_professional: false });
test('calendar consent indicators use two bounded queries regardless of card count', async () => {
  const db = fake([signed()]); const rows = Array.from({ length: 200 }, (_, i) => appointment(i + 1)); await attach(db, rows);
  assert.equal(db.calls.length, 2); assert(rows.every(r => r.consent_summary.pending_required === 0));
  assert.equal(db.calls[0][1].limit, 5001); assert.equal(db.calls[1][1].limit, 10001);
});
test('other clinic signatures and unsigned professional countersignatures do not turn cards green', async () => {
  for (const change of [{ clinica_id: 99 }, { status: 'revoked' }, { requires_professional: true }, { expires_at: '2020-01-01' }]) {
    const rows = [appointment()]; await attach(fake([{ ...signed(), ...change }]), rows); assert.equal(rows[0].consent_summary.has_pending, true);
  }
});
test('over-limit, missing treatment and program projections remain unknown', async () => {
  const rows = [appointment()]; await attach(fake([], Array(5001).fill({})), rows); assert.equal(rows[0].consent_summary, undefined);
  const db = fake([]); const others = [{ ...appointment(), tratamiento_id: null }, { ...appointment(), source_system: 'treatment_program' }]; await attach(db, others); assert.equal(db.calls.length, 0);
});
test('verified programme composition includes all pending signatures with no per-card queries', async () => {
  const rows = [{ ...appointment(), source_system: 'treatment_program',
    program_context: { status: 'linked', treatment_ids: [4, 6] } }];
  const db = fake([signed()], [
    { tratamiento_id: 4, clinic_template_id: 5, required: true, clinicTemplate: { status: 'active', validity_mode: 'manual' } },
    { tratamiento_id: 6, clinic_template_id: 7, required: false, clinicTemplate: { status: 'active' } },
    { tratamiento_id: 6, clinic_template_id: 8, required: true, clinicTemplate: { status: 'inactive' } },
    { tratamiento_id: 6, clinica_id: 99, clinic_template_id: 9, required: true, clinicTemplate: { status: 'active' } },
  ]);
  await attach(db, rows);
  assert.equal(db.calls.length, 2);
  assert.deepEqual(db.calls[0][1].where.tratamiento_id[Sequelize.Op.in], [4, 6]);
  assert.deepEqual(rows[0].consent_summary, { required_total: 1, signed_required: 1,
    pending_required: 0, pending_optional: 1, has_pending: true });
});
test('inactive requirements do not invent pending signatures', async () => {
  const rows = [appointment()];
  await attach(fake([], [{ tratamiento_id: 4, required: true, clinicTemplate: { status: 'inactive' } }]), rows);
  assert.equal(rows[0].consent_summary.has_pending, false);
});

// Exercise the real patient privacy projection through the lightweight agenda
// service, not just the card component with an already-populated DTO.
const privacy = require('../../services/appointmentPrivacyEligibility.service');
const choices = require('../../lib/consent-document-choices');
const paper = require('../../lib/registration-privacy-paper');
const digital = require('../../lib/bs-privacy-digital-template');
const built = digital.buildBsPrivacyDigitalHtml();
const template = { id: 600, clinic_id: 72, catalog_key: privacy.FINAL_PRIVACY_KEY, purpose: 'data_protection',
  status: 'active', is_default: true, blocking_policy: 'hard', requires_professional_signature: false };
const version = { id: 700, clinic_template_id: 600, version: 2, locale: 'es', status: 'published', body_html: built.html,
  body_json: { consent_form: built.consent_form, digital_presentation: built.metadata } };
const pendingPrivacy = { id: 800, public_id: 'cdoc_qa', paciente_id: 2, clinica_id: 72, clinic_template_id: 600,
  clinic_template_version_id: 700, purpose: 'data_protection', status: 'pending', package_id: 900, title: 'LOPD',
  snapshot_json: { template, version: { id: 700, body_json: version.body_json } }, snapshot_html: built.html,
  snapshot_hash: 'not-yet-signed', revoked_at: null, expires_at: null };
const privacyAppointment = (id = 1, extra = {}) => ({ ...appointment(id), clinica_id: 72, tratamiento_id: null, ...extra });
function privacyFake(options = {}) {
  const db = fake(options.clinicalDocuments || [], options.requirements || []), snapshots = [];
  const transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } };
  const data = { templates: [template], versions: [version], imported: [], care: [], documents: [],
    packages: [{ id: 900, paciente_id: 2, clinica_id: 72, status: 'pending', expires_at: null }],
    deliveries: [], attestations: [], events: [], ...options };
  db.sequelize = { transaction: async (config, callback) => {
    snapshots.push(config); assert.deepEqual(config, { readOnly: true, isolationLevel: 'REPEATABLE READ' });
    return callback(transaction);
  } };
  const clinicalDocumentRead = db.PatientConsentDocument.findAll;
  for (const [model, name] of [['ClinicConsentTemplate', 'templates'], ['ClinicConsentTemplateVersion', 'versions'],
    ['PatientCustomField', 'imported'], ['CitaPaciente', 'care'], ['PatientConsentDocument', 'documents'],
    ['ConsentSignaturePackage', 'packages'], ['ConsentDeliveryEvent', 'deliveries'],
    ['PatientConsentExternalAttestation', 'attestations'], ['PatientOperationalEvent', 'events']]) {
    db[model] = { findAll: async query => {
      if (name === 'documents' && !query.transaction) return clinicalDocumentRead(query);
      db.calls.push([`privacy:${name}`, query]); assert.equal(query.transaction, transaction);
      assert.equal(query.lock, undefined); assert(query.limit > 0);
      if (options.failPrivacy === name) throw new Error('privacy_read_failed');
      return data[name];
    } };
  }
  return { db, data, snapshots };
}
function signedPrivacy() {
  const doc = structuredClone(pendingPrivacy), at = new Date(Date.now() - 60_000).toISOString();
  doc.status = 'signed'; doc.signed_at = at;
  doc.snapshot_json.integrity = { algorithm: choices.CHOICE_HASH_ALGORITHM };
  doc.snapshot_json.signature_evidence = { accepted_statement: true, signed_at: at,
    consent_choices: { schema_version: choices.CHOICE_SCHEMA_VERSION,
      answers: Object.fromEntries(choices.CHOICE_KEYS.map(key => [key, 'no'])) } };
  doc.snapshot_html = choices.appendSignedChoiceHtml(built.html.trim(), doc, doc.snapshot_json.signature_evidence.consent_choices);
  doc.snapshot_hash = choices.choiceSnapshotHash(doc.snapshot_json, doc.snapshot_html);
  return doc;
}

test('empty page and non-BS appointments add no privacy transaction or queries', async () => {
  await attach({}, []);
  const { db, snapshots } = privacyFake();
  const rows = [{ ...appointment(), tratamiento_id: null }]; await attach(db, rows);
  assert.equal(db.calls.length, 0); assert.equal(snapshots.length, 0); assert.equal(rows[0].consent_summary, undefined);
});
test('lightweight appointment without a treatment includes required LOPD without invented clinical counters', async () => {
  const { db, snapshots } = privacyFake(), row = privacyAppointment(); await attach(db, [row]);
  assert.deepEqual(Object.keys(row.consent_summary), ['privacy']);
  assert.equal(row.consent_summary.privacy.state, 'not_requested');
  assert.equal(row.consent_summary.privacy.attention_required, true);
  assert.equal(row.consent_summary.privacy.document_id, null); assert.equal(snapshots.length, 1);
  assert(db.calls.every(([name]) => name.startsWith('privacy:')));
});
test('imported or previously attended patients show missing LOPD without losing their care exemption or inventing a request', async () => {
  for (const options of [{ imported: [{ paciente_id: 2, value: '1075' }] },
    { care: [{ paciente_id: 2, clinica_id: 72, first_care_id: 9, last_care_id: 9 }] }]) {
    const { db } = privacyFake(options), row = privacyAppointment(); await attach(db, [row]);
    assert.equal(row.consent_summary.privacy.state, 'not_requested');
    assert.equal(row.consent_summary.privacy.attention_required, true);
    assert.equal(row.consent_summary.privacy.required, false);
    assert.equal(row.consent_summary.privacy.allowed, true);
    assert.equal(row.consent_summary.privacy.has_pending, false);
    assert.equal(row.consent_summary.privacy.document_id, null);
  }
});
test('both BS clinics project missing or cancelled LOPD on imported cards without reactivating documents', async () => {
  for (const clinicId of [66, 72]) for (const cancelled of [false, true]) {
    const { db } = privacyFake({ templates: [{ ...template, clinic_id: clinicId }],
      imported: [{ paciente_id: 2, value: '1075' }],
      documents: cancelled ? [{ ...pendingPrivacy, clinica_id: clinicId, status: 'cancelled' }] : [] });
    const row = privacyAppointment(1, { clinica_id: clinicId }); await attach(db, [row]);
    const result = row.consent_summary.privacy;
    assert.equal(result.state, 'not_requested'); assert.equal(result.attention_required, true);
    assert.equal(result.allowed, true); assert.equal(result.required, false); assert.equal(result.has_pending, false);
    assert.equal(result.document_id, null); assert.equal(result.package_id, null);
  }
});
for (const state of ['pending', 'sent', 'viewed']) {
  test(`lightweight ${state} LOPD is visible even on an imported patient without treatment`, async () => {
    const { db } = privacyFake({ imported: [{ paciente_id: 2, value: '1075' }],
      documents: [{ ...pendingPrivacy, status: state }] });
    const row = privacyAppointment(); await attach(db, [row]);
    assert.equal(row.consent_summary.privacy.state, state);
    assert.equal(row.consent_summary.privacy.attention_required, true);
    assert.equal(row.consent_summary.privacy.required, false);
  });
}
test('digitally signed LOPD is quiet on the real lightweight projection', async () => {
  const { db } = privacyFake({ documents: [signedPrivacy()] }), row = privacyAppointment(); await attach(db, [row]);
  assert.equal(row.consent_summary.privacy.state, 'signed');
  assert.equal(row.consent_summary.privacy.attention_required, false);
});
test('audited paper LOPD is quiet without fabricating a digital document', async () => {
  const at = new Date(Date.now() - 60_000), source = paper.PATIENT_PAPER_SOURCE;
  const attestation = { id: 5, paciente_id: 2, clinica_id: 72, tratamiento_id: null, purpose: 'data_protection',
    source, status: 'active', attested_by: 7, attested_at: at, revoked_at: null, revoked_by: null };
  const event = { id: 6, patient_id: 2, clinic_id: 72, actor_user_id: 7, event_type: paper.PAPER_EVENT,
    source, channel: 'internal', occurred_at: at, metadata: { schema_version: source, attestation_id: 5,
      appointment_id: null, clinic_template_id: 600, clinic_template_version_id: 700, catalog_key: privacy.FINAL_PRIVACY_KEY,
      source_document_sha256: digital.SOURCE_DOCUMENT_SHA256, legal_text_sha256: digital.LEGAL_TEXT_SHA256,
      acknowledged: true, recorded_at: at.toISOString() } };
  const { db } = privacyFake({ attestations: [attestation], events: [event] }), row = privacyAppointment();
  await attach(db, [row]); assert.equal(row.consent_summary.privacy.state, 'paper');
  assert.equal(row.consent_summary.privacy.attention_required, false); assert.equal(row.consent_summary.privacy.document_id, null);
});
test('clinical counters and LOPD coexist without one replacing the other', async () => {
  const { db } = privacyFake({ documents: [pendingPrivacy], requirements: [
    { tratamiento_id: 4, clinica_id: 72, clinic_template_id: 5, clinicTemplate: { status: 'active', validity_mode: 'manual' } },
  ] });
  const row = privacyAppointment(1, { tratamiento_id: 4 }); await attach(db, [row]);
  assert.equal(row.consent_summary.pending_required, 1); assert.equal(row.consent_summary.has_pending, true);
  assert.equal(row.consent_summary.privacy.state, 'pending'); assert.equal(row.consent_summary.privacy.attention_required, true);
});
test('group scope keeps each LOPD tied to its own clinic, including the same shared patient', async () => {
  const medicalTemplate = { ...template, id: 601, clinic_id: 66 };
  const medicalVersion = { ...version, id: 701, clinic_template_id: 601 };
  const { db, snapshots } = privacyFake({ templates: [template, medicalTemplate], versions: [version, medicalVersion],
    documents: [pendingPrivacy] });
  const rows = [privacyAppointment(), privacyAppointment(2, { clinica_id: 66 })]; await attach(db, rows);
  assert.equal(snapshots.length, 1);
  assert.equal(rows[0].consent_summary.privacy.state, 'pending');
  assert.equal(rows[0].consent_summary.privacy.clinic_id, 72);
  assert.equal(rows[1].consent_summary.privacy.state, 'not_requested');
  assert.equal(rows[1].consent_summary.privacy.clinic_id, 66);
  assert.equal(rows[1].consent_summary.privacy.attention_required, true);
  assert.equal(rows[1].consent_summary.privacy.document_id, null);
});
test('clinical early-return bounds never discard independently resolved LOPD', async () => {
  for (const options of [{ requirements: Array(5001).fill({}) }, { clinicalDocuments: Array(10001).fill({}) }]) {
    const { db } = privacyFake({ documents: [pendingPrivacy], ...options });
    const row = privacyAppointment(1, { tratamiento_id: 4 }); await attach(db, [row]);
    assert.deepEqual(Object.keys(row.consent_summary), ['privacy']);
    assert.equal(row.consent_summary.privacy.attention_required, true);
  }
});
test('privacy snapshot failures are visible and preserve clinical counters, never stale privacy', async () => {
  const { db } = privacyFake({ failPrivacy: 'templates', requirements: [
    { tratamiento_id: 4, clinica_id: 72, clinic_template_id: 5, clinicTemplate: { status: 'active' } },
  ] });
  const row = privacyAppointment(1, { tratamiento_id: 4, consent_summary: { privacy: { state: 'signed' } } });
  await attach(db, [row]); assert.equal(row.consent_summary.privacy_error, true);
  assert.equal(row.consent_summary.privacy, undefined); assert.equal(row.consent_summary.pending_required, 1);
  assert.equal(row.consent_summary.has_pending, true);
});
test('per-patient privacy failures do not hide other rows in the same snapshot', async () => {
  const { db } = privacyFake({ documents: Array.from({ length: 101 }, (_, index) => ({ ...pendingPrivacy, id: 800 + index })) });
  const rows = [privacyAppointment(), privacyAppointment(2, { paciente_id: 3 })]; await attach(db, rows);
  assert.equal(rows[0].consent_summary.privacy_error, true);
  assert.equal(rows[1].consent_summary.privacy.state, 'not_requested');
  assert.equal(rows[1].consent_summary.privacy.attention_required, true);
});
test('many cards share one bounded privacy snapshot, not a query per card', async () => {
  const one = privacyFake({ documents: [pendingPrivacy] }); await attach(one.db, [privacyAppointment()]);
  const many = privacyFake({ documents: [pendingPrivacy] });
  const rows = Array.from({ length: 200 }, (_, index) => privacyAppointment(index + 1)); await attach(many.db, rows);
  assert.equal(many.snapshots.length, 1); assert.equal(many.db.calls.length, one.db.calls.length);
  assert(many.db.calls.length <= 9); assert(rows.every(row => row.consent_summary.privacy.state === 'pending'));
});
test('many imported cards without LOPD keep one bounded snapshot without inventing clinical counters', async () => {
  const f = privacyFake({ imported: [{ paciente_id: 2, value: '1075' }] });
  const rows = Array.from({ length: 200 }, (_, index) => privacyAppointment(index + 1)); await attach(f.db, rows);
  assert.equal(f.snapshots.length, 1); assert(f.db.calls.length <= 7);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row.consent_summary), ['privacy']);
    assert.equal(row.consent_summary.privacy.attention_required, true);
    assert.equal(row.consent_summary.privacy.has_pending, false); assert.equal(row.consent_summary.privacy.allowed, true);
  }
});
test('model rows receive merged privacy and clinical summaries via setDataValue', async () => {
  const values = privacyAppointment(1, { tratamiento_id: 4, consent_summary: { privacy_error: true } });
  const model = { toJSON: () => ({ ...values }), setDataValue: (key, value) => { values[key] = value; } };
  const { db } = privacyFake({ documents: [pendingPrivacy] }); await attach(db, [model]);
  assert.equal(values.consent_summary.privacy.state, 'pending'); assert.equal(values.consent_summary.privacy_error, undefined);
  assert.equal(values.consent_summary.pending_required, 0);
});
test('clinical query failures retain the existing rejection policy', async () => {
  const { db } = privacyFake(); db.TreatmentConsentRequirement.findAll = async () => { throw new Error('clinical_read_failed'); };
  await assert.rejects(attach(db, [privacyAppointment(1, { tratamiento_id: 4 })]), /clinical_read_failed/);
});
