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
function fixture({ imported = null, prior = null, documents = [], currentTemplate = template, currentVersion = version, oldVersions = [] } = {}) {
  const calls = [], transaction = { LOCK: { SHARE: 'SHARE' } }, Op = { ne: Symbol('ne'), lte: Symbol('lte'), or: Symbol('or'), in: Symbol('in') };
  const reader = (name, value) => ({ findOne: async options => { calls.push([name, options]); assert.equal(options.transaction, transaction); assert.equal(options.lock, 'SHARE'); return value; } });
  const db = { Sequelize: { Op }, Paciente: { findByPk: async (_id, q) => { assert.equal(q.lock, 'SHARE'); return { id_paciente: 2, clinica_id: 72 }; } },
    PatientCustomField: { findAll: async options => { calls.push(['imported', options]); assert.equal(options.transaction, transaction); assert.equal(options.lock, 'SHARE'); return Array.isArray(imported) ? imported : imported ? [imported] : []; } }, CitaPaciente: reader('prior_care', prior),
    ClinicConsentTemplate: reader('template', currentTemplate), ClinicConsentTemplateVersion: { ...reader('version', currentVersion),
      findAll: async q => { calls.push(['previous_versions', q]); assert.equal(q.transaction, transaction); assert.equal(q.lock, 'SHARE'); assert.equal(q.limit, 101); return oldVersions; } },
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

const digital = require('../../lib/bs-privacy-digital-template');
// The repository adds a terminal newline; the approved issued source did not.
const oldHtml = fs.readFileSync(require.resolve('./fixtures/bs-privacy-approved-legacy.html'), 'utf8').replace(/\n$/, '');
const legacyVersion = { id: 700, clinic_template_id: template.id, version: 1, locale: 'es', status: 'published',
  body_html: oldHtml, body_json: { consent_form: form } };
const built = digital.buildBsPrivacyDigitalHtml();
const digitalVersion = { id: 701, clinic_template_id: template.id, version: 2, locale: 'es', status: 'published',
  body_html: built.html, body_json: { consent_form: built.consent_form, digital_presentation: built.metadata } };
function signedVersion(source, patch = {}) {
  const doc = { ...signed, clinic_template_version_id: source.id, snapshot_json: structuredClone(signed.snapshot_json), ...patch };
  doc.snapshot_json.version = { id: source.id, body_json: source.body_json };
  doc.snapshot_html = require('../../lib/consent-document-choices').appendSignedChoiceHtml(source.body_html.trim(), doc,
    doc.snapshot_json.signature_evidence.consent_choices);
  doc.snapshot_hash = choiceSnapshotHash(doc.snapshot_json, doc.snapshot_html);
  return doc;
}
test('approved digital presentation preserves an exact previous four-No signature without rewriting it', async () => {
  assert.equal(require('node:crypto').createHash('sha256').update(oldHtml).digest('hex'), digital.APPROVED_LEGACY_HTML_SHA256);
  const old = signedVersion(legacyVersion), before = JSON.stringify(old);
  const f = fixture({ currentVersion: digitalVersion, oldVersions: [legacyVersion], documents: [old] });
  assert.equal((await f.enforce()).allowed, true);
  assert.equal(JSON.stringify(old), before, 'historical signature and snapshot remain byte-for-byte unchanged');
  const q = f.calls.find(([name]) => name === 'documents')[1];
  assert.deepEqual(q.where.clinic_template_version_id[f.db.Sequelize.Op.in], [701, 700]);
  const oldQuery = f.calls.find(([name]) => name === 'previous_versions')[1];
  assert.equal(oldQuery.where.clinic_template_id, template.id); assert.equal(oldQuery.where.status, 'published');
  assert.equal(oldQuery.where.locale, 'es');
});
test('new digital signature with four explicit No answers permits care', async () => {
  const f = fixture({ currentVersion: digitalVersion, documents: [signedVersion(digitalVersion)] });
  assert.equal((await f.enforce()).allowed, true);
});
test('digital snapshots bind the exact rendered clauses, escaped patient identity and approved metadata', async () => {
  const current = signedVersion(digitalVersion);
  current.snapshot_json.context = { paciente: { nombre_completo: 'Paciente ficticio <QA>', dni: 'NO-REAL' } };
  current.snapshot_html = require('../../lib/consent-document-choices').appendSignedChoiceHtml(
    digital.buildBsPrivacyDigitalHtml(current.snapshot_json.context).html, current,
    current.snapshot_json.signature_evidence.consent_choices);
  current.snapshot_hash = choiceSnapshotHash(current.snapshot_json, current.snapshot_html);
  assert.equal((await fixture({ currentVersion: digitalVersion, documents: [current] }).run()).allowed, true);
  for (const mutate of [doc => { doc.snapshot_html = doc.snapshot_html.replace('INSTITUTO OBES ALICANTE', 'OTRA ENTIDAD'); },
    doc => { doc.snapshot_json.context.paciente.dni = 'OTRO'; },
    doc => { delete doc.snapshot_json.version.body_json.digital_presentation; }]) {
    const changed = structuredClone(current); mutate(changed);
    changed.snapshot_hash = choiceSnapshotHash(changed.snapshot_json, changed.snapshot_html);
    assert.equal((await fixture({ currentVersion: digitalVersion, documents: [changed] }).run()).allowed, false);
  }
});
for (const [label, patch] of [
  ['draft', { status: 'draft' }], ['archived', { status: 'archived' }],
  ['another template', { clinic_template_id: 999 }], ['another locale', { locale: 'fr' }],
  ['changed old legal text', { body_html: oldHtml + '<p>Alterado</p>' }],
  ['missing old choice form', { body_json: {} }],
]) test('presentation compatibility rejects ' + label, async () => {
  const f = fixture({ currentVersion: digitalVersion, oldVersions: [{ ...legacyVersion, ...patch }], documents: [signedVersion(legacyVersion)] });
  assert.equal((await f.run()).allowed, false);
});
for (const [label, patch] of [
  ['another patient', { paciente_id: 3 }], ['another clinic', { clinica_id: 66 }],
  ['another template', { clinic_template_id: 999 }], ['expired', { expires_at: now }],
  ['revoked', { revoked_at: now }], ['future signature', { signed_at: '2026-10-16T00:00:00Z' }],
]) test('compatible old signature still rejects ' + label, async () => {
  assert.equal((await fixture({ currentVersion: digitalVersion, oldVersions: [legacyVersion],
    documents: [{ ...signedVersion(legacyVersion), ...patch }] }).run()).allowed, false);
});
test('a copied digital marker alone never authorizes historical versions', async () => {
  for (const fake of [{ ...digitalVersion, body_html: '<p>Otro texto legal</p>' },
    { ...digitalVersion, body_json: { ...digitalVersion.body_json, digital_presentation: { ...built.metadata, source_html_sha256: 'a'.repeat(64) } } }]) {
    const f = fixture({ currentVersion: fake, oldVersions: [legacyVersion], documents: [signedVersion(legacyVersion)] });
    assert.equal((await f.run()).allowed, false);
    assert.equal(f.calls.some(([name]) => name === 'previous_versions'), false);
  }
});
test('rehashed but different historical rendered text is not the approved presentation', async () => {
  const old = signedVersion(legacyVersion);
  old.snapshot_html = old.snapshot_html.replace('INSTITUTO OBES ALICANTE', 'OTRA ENTIDAD');
  old.snapshot_hash = choiceSnapshotHash(old.snapshot_json, old.snapshot_html);
  assert.equal((await fixture({ currentVersion: digitalVersion, oldVersions: [legacyVersion], documents: [old] }).run()).allowed, false);
});
test('historical choice receipt must have four explicit canonical answers and a current evidence date', async () => {
  for (const patch of [snapshot => { delete snapshot.signature_evidence.consent_choices.answers.sms; },
    snapshot => { snapshot.signature_evidence.signed_at = '2026-10-16T00:00:00Z'; },
    snapshot => { snapshot.version.id = 999; }, snapshot => { snapshot.template.clinic_id = 66; }]) {
    const old = signedVersion(legacyVersion); patch(old.snapshot_json);
    old.snapshot_hash = choiceSnapshotHash(old.snapshot_json, old.snapshot_html);
    assert.equal((await fixture({ currentVersion: digitalVersion, oldVersions: [legacyVersion], documents: [old] }).run()).allowed, false);
  }
});
test('compatibility reads are bounded and fail closed when the version limit is exceeded', async () => {
  await assert.rejects(fixture({ currentVersion: digitalVersion, oldVersions: Array(101).fill(legacyVersion) }).run(),
    { code: 'appointment_consent_privacy_configuration' });
});
