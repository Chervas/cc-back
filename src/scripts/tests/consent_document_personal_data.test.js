'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helper = require('../../lib/consent-document-personal-data');
const digital = require('../../lib/bs-privacy-digital-template');
const choices = require('../../lib/consent-document-choices');
const now = new Date('2026-10-16T10:00:00Z');
function document() {
  const rendered = digital.buildBsPrivacyDigitalHtml();
  const snapshot = { template: { id: 10, clinic_id: 72,
    catalog_key: 'bs-final-20261015-' + digital.SOURCE_DOCUMENT_SHA256, requires_representative_when_minor: true },
    version: { id: 20, body_json: { digital_presentation: rendered.metadata, consent_form: rendered.consent_form } },
    context: { paciente: { id: 30, nombre: 'Paciente', apellidos: 'Ficticio', nombre_completo: 'Paciente Ficticio',
      dni: '', fecha_nacimiento: '01/02/1990', direccion: 'Calle original 1' }, clinica: { id: 72 } },
    patient_flags: { is_minor: false }, integrity: { algorithm: choices.CHOICE_HASH_ALGORITHM } };
  const html = digital.buildBsPrivacyDigitalHtml(snapshot.context).html;
  return { id: 40, clinic_template_id: 10, clinica_id: 72, paciente_id: 30, purpose: 'data_protection',
    status: 'pending', snapshot_json: snapshot, snapshot_html: html, snapshot_hash: choices.choiceSnapshotHash(snapshot, html) };
}
const payload = doc => ({ schema_version: helper.SCHEMA_VERSION, snapshot_hash: doc.snapshot_hash,
  values: helper.contextValues(doc.snapshot_json.context) });
test('issued identity is editable and prefilled, independent from a medical questionnaire', () => {
  const doc = document(), before = JSON.stringify(doc), form = helper.publicDocumentPersonalData(doc).personal_data_form;
  assert.equal(form.editable, true); assert.equal(form.confirmed, false);
  assert.equal(form.values.fecha_nacimiento, '1990-02-01');
  assert.equal(form.values.direccion, 'Calle original 1');
  assert.deepEqual(form.fields.filter(row => row.required).map(row => row.key), ['nombre', 'apellidos']);
  assert.equal(form.fields.length, 12); assert.equal(form.values.compania, ''); assert.equal(form.values.telefono2, '');
  assert.equal(JSON.stringify(doc), before);
});
test('confirmation keeps approved wording and identity IDs, changes only whitelisted frozen document context', () => {
  const doc = document(), before = JSON.stringify(doc), request = payload(doc);
  request.values.nombre = '<script>Ficticio</script>'; request.values.direccion = 'Calle nueva & 2';
  request.values.compania = 'Entidad QA & prueba'; request.values.telefono2 = '+34 000000001';
  const next = helper.correctedSnapshot(doc, request, { ip: '127.0.0.1' }, now);
  const saved = { ...doc, ...next };
  assert.equal(JSON.stringify(doc), before);
  assert.equal(saved.snapshot_json.context.paciente.id, 30);
  assert.equal(saved.snapshot_json.context.paciente.documento, '');
  assert.equal(saved.snapshot_json.context.paciente.direccion, 'Calle nueva & 2');
  assert.match(saved.snapshot_html, /&lt;script&gt;Ficticio&lt;\/script&gt;/);
  assert.match(saved.snapshot_html, /Calle nueva &amp; 2/);
  assert.match(saved.snapshot_html, /Entidad QA &amp; prueba/);
  assert.match(saved.snapshot_html, /Segundo teléfono<\/dt><dd>\+34 000000001/);
  assert(!saved.snapshot_html.includes('<script>'));
  for (const block of digital.LEGAL_BLOCKS) assert(saved.snapshot_html.includes(block.text));
  assert.equal(saved.snapshot_json.patient_identity.profile_updated, false);
  assert.equal(saved.snapshot_json.patient_identity.previous_snapshot_hash, doc.snapshot_hash);
  assert.equal(helper.publicDocumentPersonalData(saved).personal_data_form.confirmed, true);
  helper.assertReadyToSign(saved, { document_snapshot_hashes: { [doc.id]: saved.snapshot_hash } });
});
test('omitted optional fields may be empty and all four No choices remain independent of identity', () => {
  const doc = document(), request = payload(doc);
  for (const field of helper.FIELDS.filter(row => !row.required)) request.values[field.key] = '';
  const next = helper.correctedSnapshot(doc, request, {}, now);
  assert.equal(helper.publicDocumentPersonalData({ ...doc, ...next }).personal_data_form.confirmed, true);
  assert.equal(choices.getConsentChoiceForm({ snapshot_json: next.snapshot_json }).fields.length, 4);
});
for (const change of [
  req => { req.values.extra = 'bad'; }, req => { delete req.values.dni; },
  req => { req.values.nombre = ''; }, req => { req.values.apellidos = '   '; },
  req => { req.values.dni = {}; }, req => { req.values.nombre = 'x'.repeat(151); },
  req => { req.values.nombre = 'Control\nchar'; }, req => { req.values.email = 'not@valid'; },
  req => { req.values.telefono = '<img src=x>'; }, req => { req.values.fecha_nacimiento = '2025-02-29'; },
  req => { req.values.telefono2 = '<img src=x>'; }, req => { req.values.compania = 'x'.repeat(151); },
  req => { req.values.fecha_nacimiento = '2026-10-17'; }, req => { req.values.fecha_nacimiento = '16/10/2000'; },
  req => { req.schema_version = 'other'; }, req => { req.template = {}; },
]) test('invalid or injected identity is rejected without mutating its issued document: ' + String(change), () => {
  const doc = document(), before = JSON.stringify(doc), request = payload(doc); change(request);
  assert.throws(() => helper.correctedSnapshot(doc, request, {}, now), error => error.statusCode === 400);
  assert.equal(JSON.stringify(doc), before);
});
test('scope and full approved presentation pin cannot be widened by copied renderer metadata alone', () => {
  for (const change of [doc => { doc.clinica_id = 99; }, doc => { doc.paciente_id = 31; },
    doc => { doc.snapshot_json.template.catalog_key = 'other'; }, doc => { doc.snapshot_json.template.clinic_id = 66; },
    doc => { doc.snapshot_json.version.body_json.digital_presentation.source_document_sha256 = 'forged'; },
    doc => { doc.purpose = 'clinical'; }]) {
    const doc = document(); change(doc); assert.equal(helper.isIdentityDocument(doc), false);
    assert.deepEqual(helper.publicDocumentPersonalData(doc), {});
    assert.throws(() => helper.correctedSnapshot(doc, payload(doc), {}, now), e => e.statusCode === 409);
  }
  const doc = document(); doc.snapshot_html += '<p>Injected legal term</p>';
  assert.throws(() => helper.correctedSnapshot(doc, payload(doc), {}, now), e => e.code === 'consent_personal_data_snapshot_invalid');
});
test('stale or unconfirmed receipt cannot be signed; saving requires exact displayed hash', () => {
  const doc = document();
  assert.throws(() => helper.assertReadyToSign(doc, { document_snapshot_hashes: { 40: doc.snapshot_hash } }), e => e.code === 'consent_personal_data_confirmation_required');
  assert.throws(() => helper.correctedSnapshot(doc, { ...payload(doc), snapshot_hash: '0'.repeat(64) }, {}, now), e => e.statusCode === 409);
  const next = { ...doc, ...helper.correctedSnapshot(doc, payload(doc), {}, now) };
  assert.throws(() => helper.assertReadyToSign(next, {}), e => e.code === 'consent_personal_data_changed');
  assert.throws(() => helper.assertReadyToSign(next, { document_snapshot_hashes: { 40: doc.snapshot_hash } }), e => e.code === 'consent_personal_data_changed');
  helper.assertReadyToSign(next, { document_snapshot_hashes: { 40: next.snapshot_hash } });
});
test('identity DOB changes can tighten but never remove an already captured minor restriction', () => {
  const doc = document(); doc.snapshot_json.patient_flags.is_minor = true;
  doc.snapshot_hash = choices.choiceSnapshotHash(doc.snapshot_json, doc.snapshot_html);
  const request = payload(doc); request.values.fecha_nacimiento = '1990-01-01';
  assert.equal(helper.correctedSnapshot(doc, request, {}, now).snapshot_json.patient_flags.is_minor, true);
  const adult = document(), young = payload(adult); young.values.fecha_nacimiento = '2015-01-01';
  assert.equal(helper.correctedSnapshot(adult, young, {}, now).snapshot_json.patient_flags.is_minor, true);
});
test('snapshot receipt map rejects malformed and foreign IDs and is scoped per document for batch signing', () => {
  const doc = document(), hash = doc.snapshot_hash;
  helper.validateSnapshotMap({ document_snapshot_hashes: { 40: hash } }, [doc]);
  for (const value of [[], { 41: hash }, { 40: {} }, { 40: 'wrong' }, { '040': hash }]) {
    assert.throws(() => helper.validateSnapshotMap({ document_snapshot_hashes: value }, [doc]), e => e.statusCode === 400);
  }
  assert.deepEqual(helper.payloadForDocument(doc, { document_snapshot_hashes: { 40: hash, 41: hash } }),
    { document_snapshot_hashes: { 40: hash } });
});
test('signed history is readonly and is never retroactively required to contain new identity confirmation', () => {
  const doc = document(); doc.status = 'signed'; doc.signed_at = now;
  const form = helper.publicDocumentPersonalData(doc).personal_data_form;
  assert.equal(form.editable, false); assert.equal(form.confirmed, false);
});
