'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const { createHash } = require('node:crypto');
const C = require('../../../ops/security/schema-contract.json');
const { effectiveContract } = require('../../lib/securitySchemaContract');
const P = require('../../lib/delegatedSchemaPreflight');
test('delegated registry is a selected additive feature dependency with an exact migration pin', () => {
  assert.equal(effectiveContract(C, {}).tables.DelegatedSessions, undefined);
  assert(!effectiveContract(C, {}).migrations.some(row => row.name === P.MIGRATION));
  assert(effectiveContract(C, { AUTH_DELEGATION_ENABLED: 'true' }).tables.DelegatedSessions);
  assert.equal(C.migrations.find(row => row.name === P.MIGRATION).sha256,
    createHash('sha256').update(fs.readFileSync('migrations/' + P.MIGRATION)).digest('hex'));
  const table = C.tables.DelegatedSessions;
  assert.equal(table.foreignKeys.length, 3);
  assert(table.foreignKeys.every(key => key.DELETE_RULE === 'RESTRICT' && key.UPDATE_RULE === 'RESTRICT'));
  assert(table.indexes.find(row => row.name === 'handoff_digest').columns.every(col => col.NON_UNIQUE === 0));
});
test('grant preflight accepts exact table/database grants and never invents delete, role or column grants', () => {
  const grants = text => [{ Grant: text }];
  assert.deepEqual(P.privileges(grants("GRANT SELECT, INSERT, UPDATE ON `clinicaclick`.`DelegatedSessions` TO `test`@`%`"), 'clinicaclick'), P.REQUIRED);
  assert.deepEqual(P.privileges(grants("GRANT ALL PRIVILEGES ON `clinicaclick`.* TO `test`@`%`"), 'clinicaclick'), P.REQUIRED);
  assert.deepEqual(P.privileges(grants("GRANT SELECT ON *.* TO `test`@`%`"), 'clinicaclick'), ['SELECT']);
  for (const text of ["GRANT ALL PRIVILEGES ON `another`.* TO `test`@`%`", "GRANT ALL PRIVILEGES ON `clinicaclick`.`Usuarios` TO `test`@`%`",
    "GRANT `a_role`@`%` TO `test`@`%`", "GRANT UPDATE (`state`) ON `clinicaclick`.`DelegatedSessions` TO `test`@`%`"]) {
    assert.deepEqual(P.privileges(grants(text), 'clinicaclick'), []);
  }
});
test('grant preflight performs only metadata reads and returns no raw account or grant strings', async () => {
  const sql = [];
  const report = await P.check(async query => { sql.push(query); return query.startsWith('SELECT')
    ? [{ database_name: 'clinicaclick' }] : [{ Grant: 'GRANT SELECT ON `clinicaclick`.* TO `FICTITIOUS_ACCOUNT`@`%`' }]; });
  assert.equal(report.compatible, false); assert.deepEqual(report.missing, ['INSERT', 'UPDATE']);
  assert.deepEqual(sql, ['SELECT DATABASE() AS database_name', 'SHOW GRANTS FOR CURRENT_USER']);
  assert(!JSON.stringify(report).includes('FICTITIOUS_ACCOUNT'));
});
