'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const blocks = require('../../lib/consent-document-blocks'), choices = require('../../lib/consent-document-choices');
const completion = require('../../lib/consent-document-completion'), personal = require('../../lib/consent-document-personal-data');
const clone = value => JSON.parse(JSON.stringify(value));
const definition = () => ({ schema_version: blocks.SCHEMA, blocks: [
  { id: 'intro', type: 'text', html: '<h3><strong>Información</strong></h3><p>{{paciente.nombre_completo}}</p>' },
  { id: 'questions', type: 'fields', title: 'Preferencias del paciente', fields: [
    { key: 'commercial', type: 'yes_no', label: '¿Deseas una copia?', required: true },
    { key: 'notes', type: 'textarea', label: 'Observaciones', required: false, max_length: 200 },
    { key: 'score', type: 'number', label: 'Valoración', required: true, min: 0, max: 10 },
    { key: 'read', type: 'checkbox', label: 'He leído la información', required: true },
    { key: 'choice', type: 'select', label: 'Formato', required: true, options: [{ value: 'digital', label: 'Digital' }, { value: 'paper', label: 'Papel' }] },
    { key: 'day', type: 'date', label: 'Día elegido', required: false },
    { key: 'mail', type: 'email', label: 'Correo para copia', required: false },
    { key: 'phone', type: 'tel', label: 'Teléfono alternativo', required: false },
  ] },
  { id: 'ending', type: 'text', html: '<p>Contenido final.</p>' },
  { id: 'signature', type: 'signature' },
] });
const fixture = ({ unsigned = false, identity = false, id = 40 } = {}) => {
  const body = { document_blocks: definition(), ...(unsigned ? { document_completion: {
    schema_version: completion.SCHEMA, signature_mode: 'none', completion_mode: 'acknowledge' } } : {}) };
  if (identity) body.document_blocks.blocks.splice(1, 0, { id: 'identity', type: 'patient_data', fields: [...blocks.KEYS] });
  const snapshot = { template: { id: 10, clinic_id: 72, purpose: 'other', requires_patient_signature: !unsigned,
    requires_representative_when_minor: !unsigned, requires_professional_signature: false },
  version: { id: 20, body_html: '<p>Source version is frozen.</p>', body_json: body },
  context: { paciente: { id: 30, nombre: 'Paciente', apellidos: 'Ficticio', nombre_completo: 'Paciente <Ficticio>' }, clinica: { id: 72 } },
  patient_flags: { is_minor: false }, integrity: { algorithm: choices.CHOICE_HASH_ALGORITHM } };
  const doc = { id, public_id: 'owned-doc-' + id, package_id: 50, paciente_id: 30, clinica_id: 72, clinic_template_id: 10,
    clinic_template_version_id: 20, purpose: 'other', status: 'viewed', signed_at: null, revoked_at: null, required: true,
    snapshot_json: snapshot, snapshot_html: blocks.renderVersion(snapshot.version, snapshot.context) };
  doc.snapshot_hash = choices.choiceSnapshotHash(snapshot, doc.snapshot_html); return doc;
};
const validAnswers = () => ({ commercial: 'no', notes: 'Dos líneas\ncon <strong>texto literal</strong>.', score: 0, read: false, choice: 'paper', day: '2026-10-17' });
const payload = (doc, answers = validAnswers()) => ({ document_ids: [doc.id], acknowledged: true,
  document_snapshot_hashes: { [doc.id]: doc.snapshot_hash }, document_block_answers: { [doc.id]: { snapshot_hash: doc.snapshot_hash, answers } } });
const signature = { signer_name: 'Paciente Ficticio', accepted_statement: true,
  signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' };

test('composition is explicitly versioned; legacy versions and snapshots are untouched', () => {
  assert.equal(blocks.versionBlocks({ body_json: {} }), null);
  const legacy = { body_html: '<p onclick="legacy()">Unchanged legacy version.</p>' };
  assert.equal(blocks.normalizeVersion(legacy, {}), legacy);
  assert.equal(blocks.renderVersion(legacy, {}), null);
  assert.deepEqual(blocks.publicFields({ snapshot_json: { version: legacy } }), {});
});
test('normalization retains semantic formatting and strips executable attributes only on a new version', () => {
  const version = { body_json: { document_blocks: definition() } }, original = JSON.stringify(version);
  version.body_json.document_blocks.blocks[0].html = '<p onclick="alert(1)" style="color:red"><strong>Texto</strong><a href="javascript:alert(1)">Enlace</a></p>';
  const next = blocks.normalizeVersion(version, { purpose: 'other' });
  assert.equal(next.body_json.document_blocks.blocks[0].html, '<p><strong>Texto</strong><a>Enlace</a></p>');
  assert(version.body_json.document_blocks.blocks[0].html.includes('onclick'), 'The input version is not mutated');
  assert.notEqual(JSON.stringify(next), original);
});
for (const [name, mutate] of [
  ['unknown schema', value => value.schema_version = 'new/v2'], ['no signature', value => value.blocks.pop()],
  ['signature not last', value => value.blocks.unshift(value.blocks.pop())], ['duplicate blocks', value => value.blocks[1].id = 'intro'],
  ['duplicate fields', value => value.blocks[1].fields[1].key = 'commercial'], ['invalid keys', value => value.blocks[1].fields[0].key = 'constructor'],
  ['unknown type', value => value.blocks[1].fields[0].type = 'html'], ['bad bounds', value => value.blocks[1].fields[2].min = 11],
  ['too many fields', value => value.blocks[1].fields = Array.from({ length: 31 }, (_, index) => ({ key: 'field_' + index, type: 'text', label: 'Campo', required: false }))],
  ['script', value => value.blocks[0].html = '<script>alert(1)</script>'], ['SVG', value => value.blocks[0].html = '<svg onload="alert(1)"></svg>'],
  ['input', value => value.blocks[0].html = '<input name="sms_whatsapp" value="yes">'],
  ['duplicate selection options', value => value.blocks[1].fields[4].options[1].value = 'digital'],
]) test('invalid schema rejected before saving: ' + name, () => { const value = definition(); mutate(value); assert.throws(() => blocks.validate(value)); });

test('privacy keeps required identity/decisions and cannot gain unsigned capability by hiding or moving blocks', () => {
  const body = { document_blocks: definition(), consent_form: require('../../lib/registration-privacy-template').form() };
  body.document_blocks.blocks.splice(1, 0, { id: 'identity', type: 'patient_data', fields: [...blocks.KEYS] });
  body.document_blocks.blocks.splice(-1, 0, { id: 'decisions', type: 'decisions' });
  assert(blocks.validate(body.document_blocks, { purpose: 'data_protection', body }));
  const missing = clone(body); missing.document_blocks.blocks[1].fields.pop();
  assert.throws(() => blocks.validate(missing.document_blocks, { purpose: 'data_protection', body: missing }));
  const hidden = clone(body); hidden.document_blocks.blocks = hidden.document_blocks.blocks.filter(block => block.type !== 'decisions');
  assert.throws(() => blocks.validate(hidden.document_blocks, { purpose: 'data_protection', body: hidden }));
  assert.throws(() => completion.validateTemplate({ body_json: { ...body, document_completion: {
    schema_version: completion.SCHEMA, signature_mode: 'none', completion_mode: 'acknowledge' } } },
  { purpose: 'data_protection', requires_patient_signature: false, requires_representative_when_minor: false, requires_professional_signature: false }));
});
test('ordered rendering resolves escaped variables and stores exact all-No/false/zero answers without grants', () => {
  const doc = fixture(), evidence = blocks.answerEvidence(doc, payload(doc));
  assert.deepEqual(evidence.answers, validAnswers());
  assert.equal(evidence.answers.commercial, 'no'); assert.equal(evidence.answers.read, false); assert.equal(evidence.answers.score, 0);
  const html = blocks.renderVersion(doc.snapshot_json.version, doc.snapshot_json.context, { answers: evidence.answers });
  assert(html.includes('Paciente &lt;Ficticio&gt;')); assert(html.includes('&lt;strong&gt;texto literal&lt;/strong&gt;'));
  assert(html.indexOf('Información') < html.indexOf('Preferencias del paciente'));
  assert(html.indexOf('Preferencias del paciente') < html.indexOf('Contenido final'));
  assert(html.includes('17/10/2026')); assert(html.includes('<dd>No</dd>')); assert(html.includes('<dd>0</dd>'));
  assert.equal(blocks.publicFields(doc).document_blocks.blocks[0].html.includes('{{'), false);
  assert.equal(blocks.publicFields(doc).document_block_answers, null);
  assert.equal(doc.snapshot_json.document_block_answers, undefined);
});
for (const [name, change] of [
  ['missing required', answers => delete answers.commercial], ['empty required', answers => answers.commercial = ''],
  ['coerced yes/no', answers => answers.commercial = false], ['coerced checkbox', answers => answers.read = 'false'],
  ['out-of-range', answers => answers.score = 11], ['nonfinite', answers => answers.score = Infinity],
  ['wrong select', answers => answers.choice = 'other'], ['invalid calendar date', answers => answers.day = '2026-02-30'],
  ['wrong date format', answers => answers.day = '17/10/2026'], ['invalid email', answers => answers.mail = 'broken@'],
  ['injected phone', answers => answers.phone = '<script>'], ['unknown field', answers => answers.sms_whatsapp = 'yes'],
  ['too long', answers => answers.notes = 'x'.repeat(201)], ['whitespace only', answers => answers.choice = '  '],
]) test('answer validation rejects ' + name, () => { const doc = fixture(), answers = validAnswers(); change(answers); assert.throws(() => blocks.answerEvidence(doc, payload(doc, answers))); });

test('answers are scoped to selected documents and exact displayed canonical snapshot', () => {
  const doc = fixture(), p = payload(doc);
  assert.throws(() => blocks.validateAnswerMap({ document_block_answers: { 41: p.document_block_answers[40] } }, [doc]));
  p.document_block_answers[40].snapshot_hash = '0'.repeat(64); assert.throws(() => blocks.answerEvidence(doc, p), { statusCode: 409 });
  const altered = fixture(); altered.snapshot_html += '<p>changed</p>'; assert.throws(() => blocks.answerEvidence(altered, payload(altered)), { statusCode: 409 });
  const empty = fixture(); empty.snapshot_json.version.body_json.document_blocks.blocks.splice(1, 1);
  assert.throws(() => blocks.answerEvidence(empty, payload(empty)), /no incluye preguntas/);
});
test('Other identity corrections alter only the issued document, preserve blocks and prevent stale completion', () => {
  const doc = fixture({ unsigned: true, identity: true });
  assert(personal.isIdentityDocument(doc)); assert.equal(personal.publicDocumentPersonalData(doc).personal_data_form.confirmed, false);
  assert.throws(() => completion.completedValues(doc, payload(doc)), /confirma tus datos/);
  const values = personal.contextValues(doc.snapshot_json.context); values.telefono = '+34 600 000 001';
  const corrected = personal.correctedSnapshot(doc, { schema_version: 'cc-registration-identity/v2', values, snapshot_hash: doc.snapshot_hash });
  const current = { ...doc, ...corrected };
  assert(personal.publicDocumentPersonalData(current).personal_data_form.confirmed);
  assert.equal(current.snapshot_json.context.paciente.telefono, values.telefono);
  assert.deepEqual(current.snapshot_json.version, doc.snapshot_json.version);
  assert.throws(() => completion.completedValues(current, payload(doc)), /ha cambiado|completion_changed/);
  const done = { ...current, ...completion.completedValues(current, payload(current)) };
  assert(completion.isCompleted(done)); assert.equal(done.signed_at, null);
  assert.deepEqual(blocks.publicFields(done).document_block_answers, validAnswers());
  assert.equal(personal.publicDocumentPersonalData(done).personal_data_form.editable, false);
});
test('unsigned block answers become immutable printable receipt, not a signature or permission', () => {
  const doc = fixture({ unsigned: true }), original = clone(doc);
  const done = { ...doc, ...completion.completedValues(doc, payload(doc)) };
  assert(completion.isCompleted(done)); assert.equal(done.status, 'completed'); assert.equal(done.signed_at, null);
  assert.equal(done.snapshot_json.signature_evidence, undefined);
  assert.deepEqual(done.snapshot_json.document_block_answers.answers, validAnswers());
  assert(done.snapshot_html.includes('Dos líneas')); assert(done.snapshot_html.includes('<dd>No</dd>'));
  assert.equal(done.snapshot_json.completion_evidence.snapshot_hash_before_completion, original.snapshot_hash);
  assert.equal(done.snapshot_hash, choices.choiceSnapshotHash(done.snapshot_json, done.snapshot_html));
  assert.deepEqual(blocks.publicFields(done).document_block_answers, validAnswers());
  assert.throws(() => completion.completedValues(done, payload(done)), /already_closed/);
  assert.deepEqual(doc, original);
  done.snapshot_html += '<p>tampered</p>'; assert.equal(completion.isCompleted(done), false);
});
test('a new block LOPD remains valid for the privacy gate with exact frozen clauses/choices/order; legacy branches are unchanged', () => {
  const doc = fixture({ identity: true }), registration = require('../../lib/registration-privacy-template');
  doc.purpose = 'data_protection'; doc.snapshot_json.template.purpose = 'data_protection';
  doc.snapshot_json.version.body_json.consent_form = registration.form();
  doc.snapshot_json.version.body_json.document_blocks.blocks.splice(-1, 0, { id: 'decisions', type: 'decisions' });
  doc.status = 'signed'; doc.signed_at = new Date().toISOString();
  const decision = { schema_version: registration.CHOICE_SCHEMA, answers: { commercial: 'no', sms_whatsapp: 'no' } };
  doc.snapshot_json.signature_evidence = { signed_at: doc.signed_at, accepted_statement: true, consent_choices: decision };
  doc.snapshot_json.document_block_answers = { schema_version: blocks.SCHEMA, answers: validAnswers() };
  doc.snapshot_html = blocks.renderVersion(doc.snapshot_json.version, doc.snapshot_json.context, { answers: validAnswers(), choiceEvidence: decision });
  doc.snapshot_hash = choices.choiceSnapshotHash(doc.snapshot_json, doc.snapshot_html);
  const gate = require('../../services/appointmentPrivacyEligibility.service'), version = clone(doc.snapshot_json.version);
  const request = { document: doc, template: doc.snapshot_json.template, patientId: 30, clinicId: 72,
    approvedVersions: new Map([[20, { version, registration: true }]]), now: new Date() };
  assert(gate.isValidSignedPrivacyDocument(request));
  const tampered = clone(doc); tampered.snapshot_html += '<p>Otra cláusula</p>';
  tampered.snapshot_hash = choices.choiceSnapshotHash(tampered.snapshot_json, tampered.snapshot_html);
  assert.equal(gate.isValidSignedPrivacyDocument({ ...request, document: tampered }), false);
});

function harness({ documents = [fixture()], conflict = false } = {}) {
  const sourcePath = require.resolve('../../services/consentimientos.service'), nativeRequire = createRequire(sourcePath), module = { exports: {} };
  const rows = clone(documents), writes = [], pack = { id: 50, public_id: 'owned-package', status: 'pending', paciente_id: 30, clinica_id: 72,
    expires_at: '2099-01-01T00:00:00Z', paciente: { nombre: 'Paciente', apellidos: 'Ficticio' }, documents: rows };
  const lookup = id => rows.find(row => String(row.id) === String(id) || row.public_id === id), Op = require('sequelize').Op;
  const db = { Sequelize: { Op }, Paciente: {}, Clinica: {}, Tratamiento: {},
    sequelize: { transaction: async (_options, work) => work({ LOCK: { UPDATE: 'UPDATE' } }) },
    PatientConsentDocument: { findByPk: async id => lookup(id), findOne: async query => lookup(query.where.public_id || query.where.id),
      findAll: async query => query.where?.package_id ? rows.filter(row => !query.where.id || query.where.id[Op.in].includes(row.id)) : [],
      update: async (patch, query) => { if (conflict) return [0]; const row = lookup(query.where.id); assert(row);
        assert.equal(query.where.snapshot_hash, row.snapshot_hash); writes.push(['document', clone(patch)]); Object.assign(row, patch); return [1]; } },
    ConsentSignaturePackage: { findByPk: async () => pack, findOne: async () => pack,
      update: async patch => { writes.push(['package', clone(patch)]); Object.assign(pack, patch); return [1]; } },
    PatientIntakeRequest: { findOne: async () => null },
    ConsentDeliveryEvent: { create: async event => { writes.push(['event', clone(event)]); return event; } } };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), { require(name) { if (name === '../../models') return db;
    if (name === 'jsonwebtoken') return { verify: () => ({ type: 'consent_signature_package', package_public_id: pack.public_id }) };
    if (name === './patientPrivacyProfile.service') return { lockAutofillAnchors: async () => {}, autofillEmptyFromDocument: async () => { throw Error('OTHER_DOCUMENT_MUST_NOT_CHANGE_PROFILE'); } };
    return nativeRequire(name); }, module, exports: module.exports, __dirname: path.dirname(sourcePath), process: { env: {} }, Buffer, console });
  return { service: module.exports, rows, writes, pack };
}
for (const method of ['direct', 'public']) test(method + ' signature freezes answers and printed order atomically, with no profile/marketing/send writes', async () => {
  const h = harness(), doc = h.rows[0], p = { ...signature, ...payload(doc) };
  if (method === 'direct') await h.service.signConsentDocument(doc.public_id, p);
  else await h.service.signPublicPackage('owned-token', p);
  const actual = h.rows[0]; assert.equal(actual.status, 'signed'); assert.deepEqual(actual.snapshot_json.document_block_answers.answers, validAnswers());
  assert.equal(actual.snapshot_hash, choices.choiceSnapshotHash(actual.snapshot_json, actual.snapshot_html));
  assert(actual.snapshot_html.indexOf('Preferencias del paciente') < actual.snapshot_html.indexOf('Contenido final'));
  const printed = await h.service.renderConsentDocument(doc.id); assert(printed.includes('Dos líneas')); assert(printed.includes('&lt;strong&gt;texto literal&lt;/strong&gt;'));
  const before = JSON.stringify(actual), count = h.writes.length;
  await assert.rejects(method === 'direct' ? h.service.signConsentDocument(doc.public_id, p) : h.service.signPublicPackage('owned-token', p));
  assert.equal(JSON.stringify(actual), before); assert.equal(h.writes.length, count);
  assert(h.writes.every(([kind]) => ['document', 'package', 'event'].includes(kind)));
});
test('signature preflight validates every selected field and CAS before any committed document', async () => {
  const h = harness({ documents: [fixture(), fixture({ id: 41 })] });
  await assert.rejects(h.service.signPublicPackage('owned-token', { ...signature, ...payload(h.rows[0]), document_ids: [40, 41] }));
  assert.equal(h.writes.length, 0);
  const conflict = harness({ conflict: true }); await assert.rejects(conflict.service.signPublicPackage('owned-token', { ...signature, ...payload(conflict.rows[0]) }));
  assert.equal(conflict.writes.length, 0);
});
test('complete retry preserves original answers/timestamps/events, rejects changed answers and foreign answer maps', async () => {
  const h = harness({ documents: [fixture({ unsigned: true })] }), p = payload(h.rows[0]);
  const result = await h.service.completePublicPackage('owned-token', p);
  assert.equal(result.completed_count, 1); assert.deepEqual(clone(result.documents[0].document_block_answers), validAnswers());
  const before = JSON.stringify(h.rows), count = h.writes.length;
  assert.equal((await h.service.completePublicPackage('owned-token', p)).completed_count, 0);
  assert.equal(JSON.stringify(h.rows), before); assert.equal(h.writes.length, count);
  const changed = clone(p); changed.document_block_answers[40].answers.commercial = 'yes';
  await assert.rejects(h.service.completePublicPackage('owned-token', changed));
  const foreign = clone(p); foreign.document_block_answers[41] = foreign.document_block_answers[40];
  await assert.rejects(h.service.completePublicPackage('owned-token', foreign));
  assert.equal(JSON.stringify(h.rows), before); assert.equal(h.writes.length, count);
});
test('multi-document completion scopes each answer entry and preflights the whole batch before writes', async () => {
  const docs = [fixture({ unsigned: true }), fixture({ unsigned: true, id: 41 })], h = harness({ documents: docs });
  const p = { acknowledged: true, document_ids: docs.map(doc => doc.id),
    document_snapshot_hashes: Object.fromEntries(docs.map(doc => [doc.id, doc.snapshot_hash])),
    document_block_answers: Object.fromEntries(docs.map(doc => [doc.id, payload(doc).document_block_answers[doc.id]])) };
  const invalid = clone(p); invalid.document_block_answers[41].answers.score = 11;
  await assert.rejects(h.service.completePublicPackage('owned-token', invalid)); assert.equal(h.writes.length, 0);
  const result = await h.service.completePublicPackage('owned-token', p);
  assert.equal(result.completed_count, 2); assert(h.rows.every(doc => completion.isCompleted(doc)));
  assert(h.rows.every(doc => doc.snapshot_json.document_block_answers.answers.score === 0));
});
