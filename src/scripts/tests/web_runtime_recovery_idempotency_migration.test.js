'use strict';

const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260719094500-add-web-runtime-recovery-idempotency');

function queryInterfaceStub({ tableExists = true, columns = {} } = {}) {
  const table = tableExists ? { id: {}, ...columns } : null;
  const calls = [];
  return {
    calls,
    async describeTable() {
      if (!table) throw new Error("Table doesn't exist");
      return { ...table };
    },
    async addColumn(name, column, definition) {
      calls.push(['addColumn', name, column, definition]);
      table[column] = {};
    },
  };
}

async function testAddsEvidenceColumnsAndRepeatedUpIsNoop() {
  const qi = queryInterfaceStub();
  await migration.up(qi, Sequelize);
  assert.deepEqual(qi.calls.map((call) => call[2]).sort(), [
    'last_recovery_action',
    'last_recovery_generation',
    'last_recovery_request_hash',
    'last_recovery_request_id',
  ]);
  const count = qi.calls.length;
  await migration.up(qi, Sequelize);
  assert.equal(qi.calls.length, count);
  await migration.down(qi, Sequelize);
  assert.equal(qi.calls.length, count);
}

async function testMissingBaseTableIsSafeNoop() {
  const qi = queryInterfaceStub({ tableExists: false });
  await migration.up(qi, Sequelize);
  assert.equal(qi.calls.length, 0);
}

async function run() {
  await testAddsEvidenceColumnsAndRepeatedUpIsNoop();
  console.log('✓ testAddsEvidenceColumnsAndRepeatedUpIsNoop');
  await testMissingBaseTableIsSafeNoop();
  console.log('✓ testMissingBaseTableIsSafeNoop');
  console.log('\n2 runtime recovery idempotency migration tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
