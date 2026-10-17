'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const helper = require('../../lib/consent-document-completion');
const now = new Date('2025-10-17T18:30:00.000Z');
const marker = { schema_version: helper.SCHEMA, signature_mode: 'none', completion_mode: 'acknowledge' };
const template = { id: 10, clinic_id: 72, purpose: 'other', requires_patient_signature: false,
  requires_representative_when_minor: false, requires_professional_signature: false };
const version = { id: 20, body_json: { document_completion: marker } };
const fixture = () => {
  const snapshot = { template: { ...template }, version: structuredClone(version),
    context: { paciente: { id: 30 }, clinica: { id: 72 } } };
  const doc = { id: 40, package_id: 50, paciente_id: 30, clinica_id: 72, clinic_template_id: 10,
    clinic_template_version_id: 20, purpose: 'other', status: 'viewed', signed_at: null, revoked_at: null,
    snapshot_html: '<p>Información útil para tu visita.</p>', snapshot_json: snapshot };
  doc.snapshot_hash = helper.hash(snapshot, doc.snapshot_html); return doc;
};
const payload = doc => ({ acknowledged: true, document_snapshot_hashes: { [doc.id]: doc.snapshot_hash } });
const complete = doc => ({ ...doc, ...helper.completedValues(doc, payload(doc), { ip: '127.0.0.1', userAgent: 'Owned QA' }, now) });

test('absence of explicit version capability never reinterprets historical false signature flags', () => {
  assert.equal(helper.policy({}, template), null);
  const doc = fixture(); delete doc.snapshot_json.version.body_json.document_completion;
  assert.equal(helper.documentPolicy(doc), null);
  assert.throws(() => helper.completedValues(doc, payload(doc), {}, now), /completion_not_allowed/);
  assert.equal(helper.publicFields(doc).requires_patient_signature, true);
});
test('no unsigned capability for LOPD, clinical, consent choices, incomplete flags or forged marker', () => {
  for (const change of [t => t.purpose = 'clinical', t => t.purpose = 'data_protection',
    t => t.requires_patient_signature = true, t => t.requires_professional_signature = true,
    t => delete t.requires_representative_when_minor]) {
    const invalid = { ...template }; change(invalid); assert.throws(() => helper.policy(version, invalid));
  }
  for (const change of [b => b.document_completion.completion_mode = 'sign', b => b.document_completion.extra = true,
    b => b.consent_form = {}, b => b.registration_privacy = {}, b => b.digital_presentation = {}]) {
    const invalid = structuredClone(version); change(invalid.body_json); assert.throws(() => helper.policy(invalid, template));
  }
  assert.throws(() => helper.validateTemplate({}, { ...template, purpose: 'data_protection' }), /privacy_patient_signature_required/);
});
test('completion has its own immutable receipt, no signature, and canonical JSON integrity', () => {
  const doc = fixture(), done = complete(doc);
  assert.equal(done.status, 'completed'); assert.equal(done.signed_at, null);
  assert.equal(done.snapshot_json.signature_evidence, undefined);
  assert.equal(helper.isCompleted(done, now), true);
  assert.equal(helper.isCompleted(JSON.parse(JSON.stringify(done, Object.keys(done))), now), false, 'Truncated nested evidence is not valid');
  const reordered = value => Array.isArray(value) ? value.map(reordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reordered(value[key])])) : value;
  assert.equal(helper.isCompleted(reordered(done), now), true, 'MySQL JSON key reordering preserves the receipt');
  assert.deepEqual(helper.publicFields(done).completion_evidence, {
    method: 'tablet_acknowledgement', completed_at: now.toISOString(), acknowledged: true });
});
test('completion refuses stale or foreign scope, expired, revoked, signed and unacknowledged payloads', () => {
  for (const change of [d => d.status = 'signed', d => d.signed_at = now.toISOString(), d => d.revoked_at = now.toISOString(),
    d => d.expires_at = now.toISOString(), d => d.snapshot_hash = '0'.repeat(64), d => d.purpose = 'clinical',
    d => d.paciente_id++, d => d.clinica_id++, d => d.clinic_template_version_id++]) {
    const doc = fixture(); change(doc); assert.throws(() => helper.completedValues(doc, payload(doc), {}, now));
  }
  const doc = fixture(); assert.throws(() => helper.completedValues(doc, { ...payload(doc), acknowledged: false }, {}, now));
  assert.throws(() => helper.completedValues(doc, { acknowledged: true }, {}, now));
  assert.throws(() => helper.completedValues(doc, payload({ ...doc, snapshot_hash: '0'.repeat(64) }), {}, now));
});
test('rehashed malicious receipt still cannot masquerade as signed, cross-clinic, future or expired completion', () => {
  for (const change of [d => d.signed_at = now.toISOString(), d => d.snapshot_json.signature_evidence = {},
    d => d.snapshot_json.completion_evidence.patient_id++, d => d.snapshot_json.completion_evidence.clinic_id++,
    d => d.snapshot_json.completion_evidence.package_id++, d => d.snapshot_json.completion_evidence.document_id++,
    d => d.snapshot_json.completion_evidence.completed_at = '2100-01-01T00:00:00Z',
    d => d.snapshot_json.completion_evidence.acknowledged = false, d => d.revoked_at = now.toISOString(),
    d => d.expires_at = now.toISOString(), d => d.snapshot_json.completion_evidence.snapshot_hash_before_completion = '0'.repeat(64)]) {
    const done = complete(fixture()); change(done); done.snapshot_hash = helper.hash(done.snapshot_json, done.snapshot_html);
    assert.equal(helper.isCompleted(done, now), false);
  }
});
test('completion migration only adds enum values and rollback refuses existing completion receipts', async () => {
  const migration = require('../../../migrations/20261017180000-add-unsigned-document-completion');
  const statements = [], types = require('../unsigned-document-completion-schema-release').TYPES;
  const columns = Object.entries(types).map(([TABLE_NAME, COLUMN_TYPE]) => ({ TABLE_NAME, COLUMN_TYPE, IS_NULLABLE: 'NO', COLUMN_DEFAULT: 'pending',
    EXTRA: '', CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_unicode_ci' }));
  const qi = { sequelize: { query: async sql => { statements.push(sql); return sql.includes('information_schema.COLUMNS') ? [columns] : [[{ total: 1 }]]; } } };
  await migration.up(qi); assert.equal(statements.length, 3);
  assert(statements.slice(1).every(sql => /^ALTER TABLE/.test(sql) && !/UPDATE|DELETE|DROP/i.test(sql)
    && sql.includes('ALGORITHM=INPLACE, LOCK=NONE') && sql.includes('COLLATE `utf8mb4_unicode_ci`')));
  await assert.rejects(() => migration.down(qi), /rollback_requires_review/);
});
