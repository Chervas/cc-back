'use strict';

const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260719090000-create-web-intake-runtime-reconciliations');

function queryInterfaceStub({ partial = false } = {}) {
  let table = partial ? { id: {}, scope_type: {}, scope_id: {} } : null;
  const indexes = [];
  const calls = [];
  const queryInterface = {
    calls,
    indexes,
    async describeTable() {
      if (!table) throw new Error("Table doesn't exist");
      return { ...table };
    },
    async createTable(name, definition) {
      calls.push(['createTable', name]);
      table = Object.fromEntries(Object.keys(definition).map((key) => [key, {}]));
    },
    async addColumn(name, column) {
      calls.push(['addColumn', name, column]);
      table[column] = {};
    },
    async changeColumn(name, column) {
      calls.push(['changeColumn', name, column]);
      table[column] = {};
    },
    async showIndex() { return indexes.map((index) => ({ ...index })); },
    async addIndex(name, fields, options) {
      calls.push(['addIndex', name, options.name]);
      indexes.push({
        name: options.name,
        unique: options.unique === true,
        fields: fields.map((attribute) => ({ attribute })),
      });
    },
    async dropTable(name) {
      calls.push(['dropTable', name]);
      table = null;
    },
  };
  queryInterface.sequelize = {
    async query(sql) {
      calls.push(['query', sql]);
      if (/FROM information_schema\.TRIGGERS/u.test(sql)) return [[], {}];
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return queryInterface;
}

async function testFreshAndRepeatedUpAreIdempotent() {
  const qi = queryInterfaceStub();
  await migration.up(qi, Sequelize);
  const structuralCallCount = () => qi.calls.filter(([kind]) => kind !== 'query').length;
  const firstCalls = structuralCallCount();
  await migration.up(qi, Sequelize);
  assert.equal(structuralCallCount(), firstCalls + 1);
  assert.equal(qi.calls.filter(([kind]) => kind !== 'query').at(-1)[0], 'changeColumn');
  assert.equal(qi.calls.filter(([kind]) => kind === 'createTable').length, 1);
  assert.equal(qi.calls.filter(([kind]) => kind === 'addIndex').length, 2);
}

async function testPartialExecutionResumesMissingColumnsAndIndexes() {
  const qi = queryInterfaceStub({ partial: true });
  await migration.up(qi, Sequelize);
  assert.equal(qi.calls.some(([kind]) => kind === 'createTable'), false);
  assert.equal(qi.calls.some(([kind, , column]) => kind === 'addColumn' && column === 'target_hmac_envelope'), true);
  assert.equal(qi.calls.some(([kind, , column]) => kind === 'changeColumn' && column === 'status'), true);
  assert.equal(qi.calls.filter(([kind]) => kind === 'addIndex').length, 2);
  await migration.down(qi);
  assert.equal(qi.calls.at(-1)[0], 'dropTable');
}

async function run() {
  await testFreshAndRepeatedUpAreIdempotent();
  console.log('✓ testFreshAndRepeatedUpAreIdempotent');
  await testPartialExecutionResumesMissingColumnsAndIndexes();
  console.log('✓ testPartialExecutionResumesMissingColumnsAndIndexes');
  console.log('\n2 web intake runtime reconciliation migration tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
