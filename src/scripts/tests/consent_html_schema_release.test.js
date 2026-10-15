'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const release = require('../consent-html-schema-release');
function fixture() {
  const columns = release.COLUMNS.map(([TABLE_NAME, COLUMN_NAME]) => ({ TABLE_NAME, COLUMN_NAME,
    COLUMN_TYPE: 'text', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null, CHARACTER_SET_NAME: 'utf8mb4',
    COLLATION_NAME: 'utf8mb4_0900_ai_ci', EXTRA: '', COLUMN_COMMENT: '' }));
  const before = { identity_sha256: 'identity', columns, contents: { documents: { count: 2, sha256: 'original' } }, metadata_names: ['old.js'] };
  const after = { ...before, columns: columns.map(r => ({ ...r, COLUMN_TYPE: 'mediumtext' })), metadata_names: ['old.js'] };
  return { before, after };
}
test('capacity release validates all exact nullable columns without changing collation', () => {
  const { before } = fixture(); release.validateColumns(before.columns);
  for (const mutate of [r => r.pop(), r => { r[0].COLUMN_TYPE = 'longtext'; }, r => { r[1].COLLATION_NAME = 'bad;sql'; }, r => { r[2].IS_NULLABLE = 'NO'; }]) {
    const rows = structuredClone(before.columns); mutate(rows); assert.throws(() => release.validateColumns(rows), /CONSENT_HTML_RELEASE_/);
  }
});
test('exact additive readback requires unchanged content and metadata', () => {
  const { before, after } = fixture(); release.verifyAfter(before, after, false);
  const registered = { ...after, metadata_names: [...before.metadata_names, release.NAME].sort() };
  release.verifyAfter(before, registered, true);
  for (const mutate of [r => { r.contents.documents.sha256 = 'changed'; }, r => { r.identity_sha256 = 'elsewhere'; }, r => { r.columns[0].COLLATION_NAME = 'utf8mb4_bin'; }, r => { r.metadata_names.push('unexpected.js'); }]) {
    const state = structuredClone(registered); mutate(state); assert.throws(() => release.verifyAfter(before, state, true), /CONTENT_SCHEMA_OR_METADATA_CHANGED/);
  }
});
test('approval is scoped to committed source, database target and a fresh pre-DDL state', () => {
  const { before } = fixture(), source = { commit: 'committed', pins: {} }, now = Date.now();
  const plan = { version: 1, target: 'crm', migration: release.NAME, source, generated_at: new Date(now).toISOString(), before };
  release.validatePlan(plan, 'crm', source, now);
  assert.throws(() => release.validatePlan(plan, 'dev', source, now));
  assert.throws(() => release.validatePlan(plan, 'crm', { commit: 'different' }, now));
  assert.throws(() => release.validatePlan(plan, 'crm', source, now + 7200001));
  assert.throws(() => release.validatePlan({ ...plan, before: { ...before, metadata_names: [release.NAME] } }, 'crm', source, now));
});
