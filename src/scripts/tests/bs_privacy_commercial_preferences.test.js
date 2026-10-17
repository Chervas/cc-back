'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('sequelize');
const helper = require('../../lib/bs-privacy-commercial-preferences');
const digital = require('../../lib/bs-privacy-digital-template');
const choices = require('../../lib/consent-document-choices');
const eligibility = require('../../services/appointmentPrivacyEligibility.service');
const now = new Date('2026-10-17T10:00:00Z');
function document(answer = 'no') {
  const built = digital.buildBsPrivacyDigitalHtml();
  const evidence = { schema_version: choices.CHOICE_SCHEMA_VERSION,
    answers: Object.fromEntries(choices.CHOICE_KEYS.map(key => [key, key === 'commercial' ? answer : 'no'])) };
  const snapshot = { template: { id: 10, clinic_id: 72, catalog_key: eligibility.FINAL_PRIVACY_KEY },
    version: { id: 20, body_json: { digital_presentation: built.metadata, consent_form: built.consent_form } },
    context: { paciente: { id: 30, nombre: 'Paciente', apellidos: 'Ficticio', telefono: '+34 600 000 001', email: 'privacy@example.invalid' }, clinica: { id: 72 } },
    integrity: { algorithm: choices.CHOICE_HASH_ALGORITHM },
    signature_evidence: { accepted_statement: true, signed_at: '2026-10-16T10:00:00Z', consent_choices: evidence } };
  const doc = { id: 40, paciente_id: 30, clinica_id: 72, clinic_template_id: 10, clinic_template_version_id: 20,
    purpose: 'data_protection', status: 'signed', signed_at: '2026-10-16T10:00:00Z', snapshot_json: snapshot };
  doc.snapshot_html = choices.appendSignedChoiceHtml(digital.buildBsPrivacyDigitalHtml(snapshot.context).html, doc, evidence);
  doc.snapshot_hash = choices.choiceSnapshotHash(snapshot, doc.snapshot_html);
  return doc;
}

function legacyDocument(answer = 'no') {
  const doc = document(answer), built = digital.buildBsPrivacyDigitalHtml();
  delete doc.snapshot_json.version.body_json.digital_presentation;
  const version = { id: 20, clinic_template_id: 10, locale: 'es', status: 'archived',
    body_html: require('node:fs').readFileSync(require.resolve('./fixtures/bs-privacy-approved-legacy.html'), 'utf8').trim(),
    body_json: { consent_form: built.consent_form }, variable_schema: { consent_form: built.consent_form } };
  doc.snapshot_html = choices.appendSignedChoiceHtml(version.body_html, doc, doc.snapshot_json.signature_evidence.consent_choices);
  doc.snapshot_hash = choices.choiceSnapshotHash(doc.snapshot_json, doc.snapshot_html);
  return { doc, version };
}

test('only an exact approved signed No is a commercial restriction; not a grant, forged body or future/revoked evidence', () => {
  assert.equal(helper.isVerifiedCommercialRefusal(document(), now), true);
  assert.equal(helper.isVerifiedCommercialRefusal(document('yes'), now), false);
  for (const change of [d => { d.status = 'pending'; }, d => { d.clinica_id = 123; },
    d => { d.revoked_at = now; }, d => { d.expires_at = now; }, d => { d.signed_at = 'invalid'; },
    d => { d.signed_at = '2027-01-01'; }, d => { d.snapshot_json.signature_evidence.signed_at = 'invalid'; },
    d => { d.snapshot_json.template.catalog_key = 'other'; }, d => { d.snapshot_json.version.id = 21; },
    d => { d.snapshot_json.context.paciente.id = 31; }, d => { d.snapshot_json.context.clinica.id = 66; },
    d => { d.snapshot_html += '<p>Cláusula no aprobada</p>'; d.snapshot_hash = choices.choiceSnapshotHash(d.snapshot_json, d.snapshot_html); },
    d => { d.snapshot_json.signature_evidence.consent_choices.answers.commercial = 'yes'; },
  ]) {
    const doc = document(); change(doc); assert.equal(helper.isVerifiedCommercialRefusal(doc, now), false, String(change));
  }
});

test('bounded read-only audience and phone-only checks recognize historical signed No across both BS clinics', async () => {
  const doc = document(), frozen = JSON.stringify(doc), reads = [];
  const db = { Sequelize: S, PatientConsentDocument: { findAll: async options => { reads.push(options); return [doc]; } },
    Paciente: { findAll: async () => [] } };
  const audience = await helper.commercialRefusals({ db, clinicIds: [66], now });
  assert(audience.patientIds.has(30)); assert(audience.phoneDigits.has('34600000001'));
  assert.deepEqual(audience.documentIds, [40]);
  await assert.rejects(helper.assertCommercialAllowed({ db, clinicIds: [72], patientIds: [30], now }),
    error => error.code === 'AUTOMATION_COMMUNICATIONS_RESTRICTED' && error.details.reason_code === 'lopd_commercial_refused');
  await assert.rejects(helper.assertCommercialAllowed({ db, clinicIds: [66], phone: '600000001', now }),
    error => error.code === 'AUTOMATION_COMMUNICATIONS_RESTRICTED');
  const otherNumber = await helper.commercialRefusals({ db, clinicIds: [66], phone: '600000002', now });
  assert.equal(otherNumber.patientIds.size, 0);
  await assert.rejects(helper.assertCommercialAllowed({ db, clinicIds: [66], email: 'PRIVACY@example.invalid', now }),
    error => error.code === 'AUTOMATION_COMMUNICATIONS_RESTRICTED');
  assert.equal((await helper.commercialRefusals({ db, clinicIds: [66], email: 'other@example.invalid', now })).patientIds.size, 0);
  assert.equal(JSON.stringify(doc), frozen, 'Restriction projection never modifies signed evidence or issues opt-ins');
  assert(reads.every(options => options.where.purpose === 'data_protection' && options.where.status === 'signed' && options.limit <= 10001));
  const count = reads.length;
  assert.equal((await helper.commercialRefusals({ db, clinicIds: [123], now })).patientIds.size, 0);
  assert.equal(reads.length, count, 'Other clinics acquire no new consent query or restriction');
});

test('review overflow fails closed and unsigned/yes-only documents cannot invent a refusal', async () => {
  const doc = document('yes');
  const db = { Sequelize: S, PatientConsentDocument: { findAll: async () => [doc] } };
  assert.equal((await helper.commercialRefusals({ db, clinicIds: [72], patientIds: [30], now })).patientIds.size, 0);
  db.PatientConsentDocument.findAll = async () => Array(101).fill(document());
  await assert.rejects(helper.commercialRefusals({ db, clinicIds: [72], patientIds: [30], now }),
    error => error.code === 'privacy_commercial_review_required');
});

test('pinned legacy No uses one bounded source-version batch, never copied body markers or forged legal bodies', async () => {
  const { doc, version } = legacyDocument(), frozen = JSON.stringify(doc), calls = [];
  const db = { Sequelize: S, PatientConsentDocument: { findAll: async () => [doc, { ...doc, id: 41 }] },
    ClinicConsentTemplateVersion: { findAll: async options => { calls.push(options); return [version]; } } };
  assert.equal(helper.isVerifiedCommercialRefusal(doc, now), false, 'A copied snapshot alone cannot authorize legacy verification');
  assert.equal(helper.isVerifiedCommercialRefusal(doc, now, version), true);
  for (const mutate of [v => { v.id = 21; }, v => { v.clinic_template_id = 11; }, v => { v.locale = 'en'; },
    v => { v.status = 'draft'; }, v => { v.body_html += '<p>Not approved</p>'; }, v => { v.body_json = {}; v.variable_schema = {}; }]) {
    const bad = structuredClone(version); mutate(bad); assert.equal(helper.isVerifiedCommercialRefusal(doc, now, bad), false);
  }
  const changed = structuredClone(doc); changed.snapshot_html += '<p>Changed signed body</p>';
  changed.snapshot_hash = choices.choiceSnapshotHash(changed.snapshot_json, changed.snapshot_html);
  assert.equal(helper.isVerifiedCommercialRefusal(changed, now, version), false, 'Even a self-consistent forged snapshot must match the exact pinned legal source');
  const result = await helper.commercialRefusals({ db, clinicIds: [66], patientIds: [30], now });
  assert(result.patientIds.has(30)); assert.deepEqual(result.documentIds, [40, 41]); assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 2); assert.deepEqual(calls[0].where.id[S.Op.in], [20]);
  assert.deepEqual(calls[0].where.status[S.Op.in], ['published', 'archived']);
  assert.equal(JSON.stringify(doc), frozen, 'Legacy signature/source evidence is never rewritten');
  db.ClinicConsentTemplateVersion.findAll = async () => [{ ...version, body_html: '<p>Unapproved source</p>' }];
  assert.equal((await helper.commercialRefusals({ db, clinicIds: [66], patientIds: [30], now })).patientIds.size, 0);
  const yes = legacyDocument('yes'); let lookups = 0;
  db.PatientConsentDocument.findAll = async () => [yes.doc];
  db.ClinicConsentTemplateVersion.findAll = async () => { lookups++; return [yes.version]; };
  assert.equal((await helper.commercialRefusals({ db, clinicIds: [66], now })).patientIds.size, 0); assert.equal(lookups, 0);
});

test('phone/email fallback stays bounded at 10001 rather than rejecting more than 100 unrelated signed records', async () => {
  const docs = Array.from({ length: 150 }, (_, index) => ({ ...document('yes'), id: 100 + index }));
  const reads = [], db = { Sequelize: S, Paciente: { findAll: async () => [] },
    PatientConsentDocument: { findAll: async options => { reads.push(options); return docs; } } };
  assert.equal((await helper.commercialRefusals({ db, clinicIds: [66], phone: '600000002', now })).patientIds.size, 0);
  assert.equal((await helper.commercialRefusals({ db, clinicIds: [66], email: 'other@example.invalid', now })).patientIds.size, 0);
  assert(reads.every(options => options.limit === 10001));
});

test('actual email boundary uses persisted marketing patient/recipient scope, while auth and care stay outside commercial refusal', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../services/marketingEmailDispatch.service'), 'utf8');
  const start = source.indexOf('async function assertEmailReviewCanDispatch('), end = source.indexOf('\nfunction plain(', start);
  assert(start > 0 && end > start);
  let stored = { id: 1, clinica_id: 66, paciente_id: 30, stream: 'marketing', metadata: {}, template_key: 'marketing.campaign' }, reads = 0;
  const db = { Sequelize: S, EmailMessage: { findByPk: async () => stored },
    PatientConsentDocument: { findAll: async () => { reads++; return [document()]; } },
    MarketingPatientList: { findByPk: async () => ({ id: 9, clinica_id: 66 }) },
    MarketingPatientListItem: { findOne: async () => ({ id: 10, clinica_id: 66, paciente_id: 30 }) } };
  const run = vm.runInNewContext(`(${source.slice(start, end)})`, { db,
    fail: code => { throw Object.assign(Error(code), { code }); },
    denyUnverifiedReviewScope: () => { throw Error('scope_invalid'); }, assertReviewAllowed: async () => ({ review: false }),
    require: name => {
      if (name === '../lib/whatsappAppointmentEligibility') return require('../../lib/whatsappAppointmentEligibility');
      if (name === '../lib/bs-privacy-commercial-preferences') return helper;
      throw Error('unexpected_dependency');
    },
  });
  await assert.rejects(run({ id: 1, clinica_id: 123 }), error => error.details?.reason_code === 'lopd_commercial_refused');
  assert.equal(reads, 1, 'Caller clinic cannot overwrite the authoritative persisted recipient scope');
  stored = { ...stored, clinica_id: null, paciente_id: null, related_type: 'marketing_bulk_send', related_id: '9:10' };
  await assert.rejects(run({ id: 1 }), error => error.details?.reason_code === 'lopd_commercial_refused');
  assert.equal(reads, 2, 'Group outbox resolves its actual stored BS campaign item before checking consent');
  for (const template_key of ['auth.email_verification', 'appointment.reminder']) {
    stored = { id: 1, clinica_id: 66, paciente_id: 30, stream: 'transactional', template_key, metadata: {} };
    assert.equal(await run({ id: 1 }), true);
  }
  assert.equal(reads, 2, 'LOPD commercial refusal never blocks ordinary authentication or operational care');
});
