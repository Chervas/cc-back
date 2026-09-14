'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { collect, TABLES, MIGRATIONS, run } = require('../security-email-login-metadata');
test('Login metadata probe reads only schema and migration names, reporting missing columns without reading clinical rows', async () => {
  const calls = [];
  const result = await collect(async (sql, values) => {
    calls.push({ sql, values }); assert(sql.startsWith('SELECT ')); assert(!/SELECT \*/.test(sql));
    if (sql.includes('information_schema.TABLES') && sql.includes('SequelizeMeta')) return [{ TABLE_NAME: 'SequelizeMeta' }];
    if (sql.includes('information_schema.TABLES')) return [{ TABLE_NAME: 'AuthSessions', ENGINE: 'InnoDB', TABLE_ROWS: 0 }];
    if (sql.includes('information_schema.COLUMNS')) return [{ TABLE_NAME: 'AuthSessions', COLUMN_NAME: 'session_id', COLUMN_TYPE: 'char(36)', IS_NULLABLE: 'NO' }];
    if (sql.includes('information_schema.STATISTICS')) return [{ TABLE_NAME: 'AuthSessions', INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, COLUMN_NAME: 'session_id', SEQ_IN_INDEX: 1 }];
    if (sql.includes('FROM SequelizeMeta')) return [{ name: MIGRATIONS[0] }];
    assert.fail('Unapproved query');
  });
  assert.equal(calls.length, 5); assert.equal(result.schemaCompatibleByColumnPresenceOnly, false);
  assert.equal(result.tables.AuthEmailChallenges.exists, false);
  assert(result.tables.AuthSessions.missingColumns.includes('authentication_method'));
  assert.equal(result.tables.AuthSessions.indexes[0].unique, true); assert.equal(result.migrations[MIGRATIONS[0]], true);
  assert(calls.filter(c => c.sql.includes('IN (')).every(c => c.values.length > 0));
});
test('Column presence is a limited finding and missing migration history does not get invented', async () => {
  const result = await collect(async sql => {
    if (sql.includes('SequelizeMeta')) return [];
    if (sql.includes('information_schema.TABLES')) return Object.keys(TABLES).map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB', TABLE_ROWS: 0 }));
    if (sql.includes('information_schema.COLUMNS')) return Object.entries(TABLES).flatMap(([TABLE_NAME, cols]) => cols.map(COLUMN_NAME => ({ TABLE_NAME, COLUMN_NAME, COLUMN_TYPE: 'fictitious', IS_NULLABLE: 'NO' })));
    return [];
  });
  assert.equal(result.schemaCompatibleByColumnPresenceOnly, true);
  assert(Object.values(result.migrations).every(v => v === false));
});
test('Metadata CLI cannot select DEV, arbitrary paths, migrations or a write operation', async () => {
  for (const args of [[], ['--write','--runtime','staging','--out','/tmp/result.json'],
    ['--read-only','--runtime','dev','--out','/tmp/result.json'], ['--read-only','--runtime','staging','--out','/tmp/result.json']])
    await assert.rejects(run(args), /email_login_metadata_invalid/);
});
