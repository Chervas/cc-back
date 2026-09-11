'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260911180000-create-campaign-workspace-optimization-runs');
const definition = require('../../../models/campaignworkspaceoptimizationrun');
const table = 'CampaignWorkspaceOptimizationRuns';

function fixture() {
  const state = { columns: null, indexes: [], created: 0, dropped: false, rows: 0 };
  const qi = {
    showAllTables: async () => state.columns ? [table] : [],
    createTable: async (name, columns) => {
      assert.equal(name, table); state.created++;
      state.columns = Object.fromEntries(Object.entries(columns).map(([key, column]) => {
        const type = typeof column.type === 'function' ? column.type() : column.type;
        return [key, { ...column, type: type.values ? `ENUM(${type.values.map(value => `'${value}'`).join(',')})` : String(type) }];
      }));
    },
    describeTable: async () => state.columns,
    showIndex: async () => state.indexes,
    addIndex: async (name, fields, options) => state.indexes.push({ ...options, fields: fields.map(attribute => ({ attribute })) }),
    getForeignKeyReferencesForTable: async () => [
      { columnName: 'setting_id', referencedTableName: 'CampaignWorkspaceSettings', referencedColumnName: 'id' },
      { columnName: 'job_request_id', referencedTableName: 'JobRequests', referencedColumnName: 'id' },
    ],
    sequelize: { query: async () => [[{ count: state.rows }]] },
    dropTable: async () => { state.dropped = true; },
  };
  return { state, qi, up: () => migration.up(qi, Sequelize) };
}
test('optimization ledger migration is additive and repeatable with exact cooldown and dedupe indexes', async () => {
  const f = fixture(); await f.up(); await f.up(); assert.equal(f.state.created, 1); assert.equal(f.state.indexes.length, 5);
  assert.deepEqual(f.state.indexes[0].fields.map(field => field.attribute), ['setting_id', 'plan_key']);
  assert.equal(f.state.indexes[0].unique, true);
  assert.equal(f.state.columns.setting_id.onDelete, 'RESTRICT'); assert.equal(f.state.columns.job_request_id.onDelete, 'SET NULL');
});
test('existing incompatible types, status values, nullability and indexes are rejected', async () => {
  for (const mutate of [f => { f.state.columns.change.type = 'TEXT'; }, f => { f.state.columns.status.type = "ENUM('queued')"; },
    f => { f.state.columns.plan_key.allowNull = true; }, f => { delete f.state.columns.submitted_at; },
    f => { f.state.indexes[0].unique = false; }, f => { f.state.indexes[1].fields.reverse(); }]) {
    const f = fixture(); await f.up(); mutate(f); await assert.rejects(f.up(), /incompatible/);
  }
});
test('both foreign keys are required and rollback refuses to erase any operational attempt', async () => {
  const f = fixture(); f.qi.getForeignKeyReferencesForTable = async () => []; await assert.rejects(f.up(), /missing foreign key/);
  const g = fixture(); await g.up(); g.state.rows = 1; await assert.rejects(migration.down(g.qi), /explicit archival/);
  assert.equal(g.state.dropped, false); g.state.rows = 0; await migration.down(g.qi); assert.equal(g.state.dropped, true);
});
test('runtime model and migration agree on the journal columns and named indexes', async () => {
  let model; definition({ define: (name, columns, options) => { model = { name, columns, options }; return model; } }, Sequelize.DataTypes);
  const f = fixture(); await f.up();
  const fields = Object.keys(f.state.columns).filter(key => !['created_at', 'updated_at'].includes(key));
  assert.deepEqual(Object.keys(model.columns).sort(), fields.sort());
  assert.equal(model.options.tableName, table);
  assert.deepEqual(model.options.indexes.map(row => row.name).sort(), f.state.indexes.map(row => row.name).sort());
});
