'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../../../migrations/20261015100000-expand-consent-html-mediumtext');

function fixture({ type = 'text', mutate = null, lengths = [0, 0, 0], dialect = 'mysql' } = {}) {
  const rows = [
    ['ClinicConsentTemplateVersions', 'body_html'], ['ConsentTemplateCatalogVersions', 'body_html'],
    ['PatientConsentDocuments', 'snapshot_html'],
  ].map(([TABLE_NAME, COLUMN_NAME]) => ({ TABLE_NAME, COLUMN_NAME, COLUMN_TYPE: type, IS_NULLABLE: 'YES',
    COLUMN_DEFAULT: null, CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_0900_ai_ci', EXTRA: '', COLUMN_COMMENT: '' }));
  if (mutate) mutate(rows);
  const changes = []; let index = 0;
  const queryInterface = { sequelize: { getDialect: () => dialect, async query(sql) {
    if (sql.includes('information_schema.COLUMNS')) return [rows];
    if (sql.includes('MAX(OCTET_LENGTH')) return [[{ maximum_bytes: lengths[index++] }]];
    changes.push(sql); return [[]];
  } } };
  return { queryInterface, changes };
}

test('up widens all 3 HTML columns and explicitly preserves collation/nullability', async () => {
  const f = fixture(); await migration.up(f.queryInterface);
  assert.equal(f.changes.length, 3);
  assert.ok(f.changes.every(sql => sql.includes('MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL')));
  assert.equal(f.changes.filter(sql => sql.includes('snapshot_html')).length, 1);
});

test('up already widened is idempotent without DDL', async () => {
  const f = fixture({ type: 'mediumtext' }); await migration.up(f.queryInterface); assert.equal(f.changes.length, 0);
});

test('all schema columns are validated before any DDL', async () => {
  for (const mutate of [rows => rows.pop(), rows => { rows[2].IS_NULLABLE = 'NO'; },
    rows => { rows[2].COLUMN_TYPE = 'longtext'; }, rows => { rows[2].COLUMN_COMMENT = 'owned'; },
    rows => { rows[2].COLLATION_NAME = 'bad;sql'; }]) {
    const f = fixture({ mutate }); await assert.rejects(migration.up(f.queryInterface), /CONSENT_HTML_/);
    assert.equal(f.changes.length, 0);
  }
});

test('wrong dialect never changes schema', async () => {
  const f = fixture({ dialect: 'sqlite' }); await assert.rejects(migration.up(f.queryInterface), /MYSQL_SCHEMA/);
  assert.equal(f.changes.length, 0);
});

test('down refuses any oversized source or signed snapshot before first DDL', async () => {
  const f = fixture({ type: 'mediumtext', lengths: [100, 65535, 65536] });
  await assert.rejects(migration.down(f.queryInterface), /WOULD_TRUNCATE/); assert.equal(f.changes.length, 0);
});

test('down preserves safe existing content and has no row mutation statements', async () => {
  const f = fixture({ type: 'mediumtext', lengths: [null, 65535, 10] }); await migration.down(f.queryInterface);
  assert.equal(f.changes.length, 3); assert.ok(f.changes.every(sql => sql.includes(' TEXT CHARACTER SET utf8mb4')));
  assert.ok(f.changes.every(sql => !/\b(?:UPDATE|DELETE|INSERT)\b/.test(sql)));
});
