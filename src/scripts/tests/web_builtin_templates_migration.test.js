'use strict';

const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260717215000-seed-web-builtin-templates-v1');

class FakeQueryInterface {
  constructor() {
    this.hasTable = true;
    this.rows = [];
    this.sequelize = {
      QueryTypes: { SELECT: 'SELECT' },
      query: async () => this.rows.map((row) => ({ ...row })),
    };
  }
  async showAllTables() {
    return this.hasTable ? ['WebTemplates'] : [];
  }
  async bulkInsert(table, rows) {
    assert.equal(table, 'WebTemplates');
    this.rows.push(...rows.map((row) => ({ ...row })));
  }
  async bulkDelete(table, where) {
    assert.equal(table, 'WebTemplates');
    this.rows = this.rows.filter((row) => !where.id.includes(row.id));
  }
}

async function main() {
  const queryInterface = new FakeQueryInterface();
  await migration.up(queryInterface);
  assert.equal(queryInterface.rows.length, 5);
  assert.ok(queryInterface.rows.every((row) => row.scope_type === 'global' && row.is_public === true && row.status === 'active'));
  assert.ok(queryInterface.rows.every((row) => /^[a-f0-9]{64}$/.test(row.document_hash)));
  assert.ok(queryInterface.rows.every((row) => JSON.parse(row.compatibility).builtin_revision === 2));
  assert.doesNotMatch(
    queryInterface.rows.map((row) => row.document).join('\n'),
    /\+3490{6,}|900000000|example\.(?:com|org|net)|localhost/i
  );
  const firstHashes = queryInterface.rows.map((row) => row.document_hash);
  await migration.up(queryInterface);
  assert.equal(queryInterface.rows.length, 5);
  assert.deepEqual(queryInterface.rows.map((row) => row.document_hash), firstHashes);

  queryInterface.rows[0].document_hash = 'f'.repeat(64);
  await assert.rejects(
    () => migration.up(queryInterface),
    (error) => error.code === 'web_builtin_template_seed_conflict'
  );
  await assert.rejects(
    () => migration.down(queryInterface),
    (error) => error.code === 'web_builtin_template_seed_down_conflict'
  );
  queryInterface.rows[0].document_hash = firstHashes[0];
  await migration.down(queryInterface);
  assert.equal(queryInterface.rows.length, 0);
  queryInterface.hasTable = false;
  await migration.down(queryInterface);
  await assert.rejects(
    () => migration.up(queryInterface),
    (error) => error.code === 'web_builtin_template_seed_missing_dependency'
  );
  console.log('web builtin templates migration: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
