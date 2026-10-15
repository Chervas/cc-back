'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const choices = require('../../lib/consent-document-choices');
const clone = value => JSON.parse(JSON.stringify(value));
const form = () => ({ schema_version: choices.CHOICE_SCHEMA_VERSION, fields: choices.CHOICE_KEYS.map(key =>
  ({ key, type: 'yes_no', required: true, label: choices.CHOICE_LABELS[key] })) });
const answers = (answer = 'no') => Object.fromEntries(choices.CHOICE_KEYS.map(key => [key, answer]));
const entry = (answer = 'no') => ({ schema_version: choices.CHOICE_SCHEMA_VERSION, answers: answers(answer) });
const payloadFor = (id = 1, answer = 'no') => ({ document_choices: { [id]: entry(answer) } });
const doc = (id = 1, withForm = true) => ({ id, public_id: `owned-doc-${id}`, package_id: 1, paciente_id: 11, clinica_id: 72,
  clinic_template_id: 880 + id, clinic_template_version_id: 990 + id, purpose: 'data_protection', required: true,
  status: 'pending', revoked_at: null, signed_at: null, snapshot_hash: `owned-hash-before-${id}`,
  snapshot_html: '<h2>LOPD ficticia para prueba local</h2><p>Texto original sin modificar.</p>',
  snapshot_json: { template: { id: 880 + id, purpose: 'data_protection', requires_representative_when_minor: true },
    patient_flags: { is_minor: false }, version: { id: 990 + id, body_json: withForm ? { consent_form: form() } : null } } });
const signature = { signer_name: 'Firmante ficticio', accepted_statement: true,
  signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('only the four literal DOCX labels in the frozen version form are accepted; no live template is read', () => {
  assert.deepEqual(choices.getConsentChoiceForm(doc()), form());
  assert.equal(choices.getConsentChoiceForm(doc(1, false)), null);
  for (const mutate of [s => s.schema_version = 'unreviewed/v2', s => s.fields.pop(), s => s.fields.reverse(),
    s => s.fields[0].required = false, s => s.fields[0].type = 'checkbox', s => s.fields[0].label = 'Authorize everything',
    s => s.fields[0].key = 'marketing_enabled', s => s.fields[0].default = 'yes']) {
    const d = doc(); mutate(d.snapshot_json.version.body_json.consent_form);
    assert.throws(() => choices.getConsentChoiceForm(d), { code: 'consent_document_choice_schema_invalid' });
  }
  const onlyMutable = doc(1, false); onlyMutable.clinicTemplate = { body_json: { consent_form: form() } };
  assert.equal(choices.getConsentChoiceForm(onlyMutable), null);
  for (const integrity of [null, {}, { algorithm: 'legacy' }, { algorithm: choices.CHOICE_HASH_ALGORITHM, fallback: true }]) {
    const bad = doc(); bad.snapshot_json.integrity = integrity;
    assert.throws(() => choices.getConsentChoiceForm(bad), { code: 'consent_document_choice_schema_invalid' });
  }
});
test('all No is valid and all four explicit yes/no values are retained without coercion or defaults', () => {
  assert.deepEqual(choices.documentChoiceEvidence(doc(), payloadFor()), entry());
  const mixed = payloadFor(); mixed.document_choices[1].answers.commercial = 'yes';
  assert.deepEqual(choices.documentChoiceEvidence(doc(), mixed), mixed.document_choices[1]);
  for (const value of [undefined, null, '', false, true, 0, 1, 'true', 'YES', 'unknown', 'not_applicable']) {
    const bad = payloadFor(); bad.document_choices[1].answers.sms = value;
    assert.throws(() => choices.documentChoiceEvidence(doc(), bad), { code: 'consent_document_choices_required' });
  }
  for (const bad of [{}, { document_choices: {} }, { document_choices: { 1: {} } },
    { document_choices: { 1: { ...entry(), schema_version: 'forged' } } },
    { document_choices: { 1: { ...entry(), answers: { ...answers(), extra: 'yes' } } } }]) {
    assert.throws(() => choices.documentChoiceEvidence(doc(), bad), { code: 'consent_document_choices_required' });
  }
});
test('foreign, unselected or invalid document maps cannot smuggle permissions; ordinary historical documents do not acquire a form', () => {
  for (const bad of [{ document_choices: [] }, { document_choices: { 'owned-doc-1': entry() } },
    { document_choices: { 2: entry() } }, { document_choices: { 1: entry(), 2: entry() } }]) {
    assert.throws(() => choices.validateDocumentChoiceMap(bad, [doc()]));
  }
  assert.throws(() => choices.documentChoiceEvidence(doc(1, false), payloadFor()), { code: 'consent_document_choices_unexpected' });
  assert.equal(choices.documentChoiceEvidence(doc(1, false), {}), null);
  assert.deepEqual(choices.payloadForDocument(doc(2), { document_choices: { 1: entry(), 2: entry('yes') }, other: true }),
    { document_choices: { 2: entry('yes') }, other: true });
});
test('signed choices are accepted only from the immutable signed snapshot and acknowledgement evidence', () => {
  const d = doc(); Object.assign(d, { status: 'signed', signed_at: '2026-10-01T09:00:00Z' });
  d.snapshot_json.signature_evidence = { signed_at: d.signed_at, accepted_statement: true, consent_choices: entry() };
  d.snapshot_json.integrity = { algorithm: choices.CHOICE_HASH_ALGORITHM };
  d.snapshot_hash = choices.choiceSnapshotHash(d.snapshot_json, d.snapshot_html);
  assert.deepEqual(choices.signedConsentChoiceAnswers(d), answers());
  for (const mutate of [r => r.status = 'pending', r => r.signed_at = null,
    r => r.snapshot_json.signature_evidence.accepted_statement = false,
    r => r.snapshot_json.signature_evidence.consent_choices.answers.commercial = '',
    r => delete r.snapshot_json.signature_evidence.consent_choices,
    r => r.snapshot_json.integrity.algorithm = 'forged', r => delete r.snapshot_json.integrity,
    r => r.snapshot_hash = 'a'.repeat(64), r => r.snapshot_html += '<p>Alterado</p>']) {
    const bad = clone(d); mutate(bad); assert.equal(choices.signedConsentChoiceAnswers(bad), null);
  }
});
test('signed HTML records all four literal questions and exact Yes/No marks while legacy HTML remains byte-identical', () => {
  const d = doc(), html = choices.appendSignedChoiceHtml(d.snapshot_html, d, entry());
  assert(html.startsWith(d.snapshot_html)); assert.equal((html.match(/☐ Sí · ☑ No/g) || []).length, 4);
  for (const label of Object.values(choices.CHOICE_LABELS)) assert(html.includes(label));
  assert.equal(choices.appendSignedChoiceHtml(d.snapshot_html, doc(1, false), null), d.snapshot_html);
  assert(!html.includes('marketing_enabled'));
});
test('interactive snapshot receipt is stable after MySQL JSON key reordering and Date serialization, but detects changes', () => {
  const first = { z: { b: 'sí', a: 'no' }, a: [{ y: 2, x: 1 }], at: new Date('2026-10-15T09:00:00Z') };
  const read = { at: '2026-10-15T09:00:00.000Z', a: [{ x: 1, y: 2 }], z: { a: 'no', b: 'sí' } };
  assert.equal(choices.choiceSnapshotHash(first, '<p>Original</p>'), choices.choiceSnapshotHash(read, '<p>Original</p>'));
  assert.notEqual(choices.choiceSnapshotHash(first, '<p>Original</p>'), choices.choiceSnapshotHash(read, '<p>Cambio</p>'));
  read.z.a = 'yes';
  assert.notEqual(choices.choiceSnapshotHash(first, '<p>Original</p>'), choices.choiceSnapshotHash(read, '<p>Original</p>'));
});

function harness({ documents = [doc()], intakePending = false, casConflict = false } = {}) {
  const sourcePath = require.resolve('../../services/consentimientos.service');
  const nativeRequire = createRequire(sourcePath), module = { exports: {} }, writes = [], calls = [];
  const rows = clone(documents);
  const pack = { id: 1, public_id: 'owned-package', status: 'pending', paciente_id: 11, clinica_id: 72,
    expires_at: '2099-01-01T00:00:00Z', paciente: { nombre: 'Paciente', apellidos: 'Ficticio' }, documents: rows };
  const lookup = identifier => rows.find(row => String(row.id) === String(identifier) || row.public_id === identifier);
  const Op = require('sequelize').Op;
  const db = { Sequelize: { Op }, Paciente: {}, Clinica: {}, Tratamiento: {},
    sequelize: { transaction: async (options, work) => work({ LOCK: { UPDATE: 'UPDATE' } }) },
    PatientConsentDocument: {
      findByPk: async id => lookup(id), findOne: async query => lookup(query.where.public_id || query.where.id),
      findAll: async query => query.where?.package_id ? rows : [],
      update: async (patch, query) => {
        calls.push(['documentCAS', clone(patch)]);
        if (casConflict) return [0];
        const row = lookup(query.where.id); assert(row);
        assert.equal(query.where.snapshot_hash, row.snapshot_hash);
        assert.equal(query.where.status, row.status);
        writes.push(['document', clone(patch)]); Object.assign(row, patch); return [1];
      },
    },
    ConsentSignaturePackage: { findByPk: async () => pack, findOne: async () => pack,
      update: async patch => { writes.push(['package', clone(patch)]); Object.assign(pack, patch); return [1]; } },
    PatientIntakeRequest: { findOne: async () => intakePending ? { status: 'pending' } : null },
    ConsentDeliveryEvent: { create: async event => { writes.push(['event', clone(event)]); return event; } },
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), {
    require(name) {
      if (name === '../../models') return db;
      if (name === 'jsonwebtoken') return { verify: () => ({ type: 'consent_signature_package', package_public_id: pack.public_id }) };
      return nativeRequire(name);
    }, module, exports: module.exports, __dirname: path.dirname(sourcePath), process: { env: {} }, Buffer, console,
  });
  return { service: module.exports, writes, calls, rows, pack };
}

for (const method of ['direct', 'public']) {
  test(`${method} signature rejects missing or forged choices and declined digital statement before any writes`, async () => {
    for (const change of [() => ({}), p => { p.document_choices[1].answers.commercial = ''; return p; },
      p => { p.document_choices[1].schema_version = 'forged'; return p; },
      p => { p.accepted_statement = false; return p; },
      p => { p.document_choices[2] = entry(); return p; }]) {
      const h = harness(), payload = change({ ...signature, ...payloadFor() });
      const run = () => method === 'direct' ? h.service.signConsentDocument('1', payload) : h.service.signPublicPackage('owned-token', payload);
      await assert.rejects(run()); assert.equal(h.writes.length, 0); assert.equal(h.rows[0].status, 'pending');
    }
  });
  test(`${method} all-No signature freezes exact choices into evidence, signed HTML, audit event and snapshot hash; replay cannot change them`, async () => {
    const h = harness(), original = clone(h.rows[0]), payload = { ...signature, ...payloadFor() };
    const signed = method === 'direct' ? await h.service.signConsentDocument('1', payload)
      : (await h.service.signPublicPackage('owned-token', payload)).documents[0];
    const actual = h.rows[0]; assert.equal(actual.status, 'signed');
    assert.deepEqual(clone(actual.snapshot_json.signature_evidence.consent_choices), entry());
    assert.equal(actual.snapshot_json.signed_copy.snapshot_hash_before_signature, original.snapshot_hash);
    assert.equal(actual.snapshot_json.integrity.algorithm, choices.CHOICE_HASH_ALGORITHM);
    assert.equal(actual.snapshot_hash, choices.choiceSnapshotHash(actual.snapshot_json, actual.snapshot_html));
    assert.equal((actual.snapshot_html.match(/☐ Sí · ☑ No/g) || []).length, 4);
    assert.deepEqual(clone(choices.signedConsentChoiceAnswers(actual)), answers());
    const event = h.writes.find(([kind]) => kind === 'event')[1];
    assert.deepEqual(clone(event.event_payload.evidence.consent_choices), entry());
    assert.equal(event.event_payload.snapshot_hash, actual.snapshot_hash);
    const print = await h.service.renderConsentDocument('1');
    assert(print.includes(actual.snapshot_html)); assert(print.includes('Opciones indicadas al firmar'));
    assert.equal((print.match(/☐ Sí · ☑ No/g) || []).length, 4);
    if (method === 'public') { assert.deepEqual(clone(signed.choice_answers), answers()); assert.equal(signed.choice_form.schema_version, choices.CHOICE_SCHEMA_VERSION); }
    const beforeReplay = JSON.stringify(actual), count = h.writes.length;
    await assert.rejects(method === 'direct' ? h.service.signConsentDocument('1', { ...signature, ...payloadFor(1, 'yes') })
      : h.service.signPublicPackage('owned-token', { ...signature, ...payloadFor(1, 'yes') }));
    assert.equal(h.writes.length, count); assert.equal(JSON.stringify(actual), beforeReplay);
    assert(h.writes.every(([kind]) => ['document', 'package', 'event'].includes(kind)), 'no patient permissions, marketing or outbound writes');
  });
}
test('public preflight validates every selected form before signing any document; per-document answers cannot cross', async () => {
  const h = harness({ documents: [doc(1), doc(2)] });
  await assert.rejects(h.service.signPublicPackage('owned-token', { ...signature, ...payloadFor(1), document_ids: [1, 2] }));
  assert.equal(h.writes.length, 0);
  const result = await h.service.signPublicPackage('owned-token', { ...signature, document_ids: [1, 2],
    document_choices: { 1: entry('no'), 2: entry('yes') } });
  assert.equal(result.signed_count, 2);
  assert.deepEqual(clone(result.documents[0].choice_answers), answers('no'));
  assert.deepEqual(clone(result.documents[1].choice_answers), answers('yes'));
});
for (const method of ['direct', 'public']) test(`${method} minor needs a representative and relationship in addition to all four choices`, async () => {
  const minor = doc(); minor.snapshot_json.patient_flags.is_minor = true;
  const h = harness({ documents: [minor] });
  const run = payload => method === 'direct' ? h.service.signConsentDocument('1', payload) : h.service.signPublicPackage('owned-token', payload);
  await assert.rejects(run({ ...signature, ...payloadFor() }), { message: 'representative_signature_required' });
  assert.equal(h.writes.length, 0);
  await assert.rejects(run({ ...signature, ...payloadFor(), signer_role: 'representative' }), { message: 'representative_signature_required' });
  assert.equal(h.writes.length, 0);
  await run({ ...signature, ...payloadFor(), signer_role: 'representative', relationship: 'Tutor' });
  assert.equal(h.rows[0].snapshot_json.signature_evidence.signer_role, 'representative');
  assert.deepEqual(clone(choices.signedConsentChoiceAnswers(h.rows[0])), answers());
});
test('legacy documents keep HTML and existing schema intact; already-signed historical evidence is never rewritten', async () => {
  const legacy = doc(1, false), h = harness({ documents: [legacy] });
  await h.service.signConsentDocument('1', signature);
  assert.equal(h.rows[0].snapshot_html, legacy.snapshot_html);
  assert.equal(Object.hasOwn(h.rows[0].snapshot_json.signature_evidence, 'consent_choices'), false);
  assert.deepEqual(clone(h.rows[0].snapshot_json.version), legacy.snapshot_json.version);
  assert.equal(choices.signedConsentChoiceAnswers(h.rows[0]), null);
  const closed = harness({ documents: [{ ...legacy, status: 'signed', signed_at: '2026-10-01' }] });
  const before = JSON.stringify(closed.rows);
  await assert.rejects(closed.service.signConsentDocument('1', { ...signature, ...payloadFor() }));
  assert.equal(closed.writes.length, 0); assert.equal(JSON.stringify(closed.rows), before);
});
test('current snapshot CAS still rejects concurrent changes and does not persist generated choice HTML on failure', async () => {
  const h = harness({ casConflict: true }), before = JSON.stringify(h.rows);
  await assert.rejects(h.service.signConsentDocument('1', { ...signature, ...payloadFor() }), { message: 'consent_document_signature_conflict' });
  assert.equal(h.writes.length, 0); assert.equal(JSON.stringify(h.rows), before);
});
