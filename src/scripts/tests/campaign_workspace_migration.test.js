'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260910140000-create-campaign-workspace-settings');

function harness() {
  const tables = new Map(); const indexes = new Map(); const calls = [];
  const qi = {
    showAllTables: async () => [...tables.keys()],
    createTable: async (name, columns) => {
      calls.push(['create', name]);
      tables.set(name, Object.fromEntries(Object.entries(columns).map(([key, column]) => {
        const type = typeof column.type === 'function' ? column.type() : column.type;
        return [key, { ...column, type: type.values ? `ENUM(${type.values.map(value => `'${value}'`).join(',')})` : String(type), primaryKey: column.primaryKey || false }];
      })));
    },
    describeTable: async name => tables.get(name),
    showIndex: async name => indexes.get(name) || [],
    addIndex: async (table, fields, options) => {
      calls.push(['index', table]);
      indexes.set(table, [...indexes.get(table) || [], { ...options, fields: fields.map(attribute => ({ attribute })) }]);
    },
    getForeignKeyReferencesForTable: async () => [{ columnName: 'setting_id', referencedTableName: 'CampaignWorkspaceSettings', referencedColumnName: 'id' }],
    dropTable: async name => { calls.push(['drop', name]); tables.delete(name); },
    sequelize: { query: async () => [[{ count: 0 }]] },
  };
  return { qi, tables, indexes, calls, up: () => migration.up(qi, Sequelize) };
}

test('settings migration creates only its two tables and is idempotent', async () => {
  const h = harness(); await h.up(); const count = h.calls.length; await h.up();
  assert.equal(h.calls.length, count);
  assert.deepEqual([...h.tables.keys()], ['CampaignWorkspaceSettings', 'CampaignWorkspaceEvents']);
});
test('partial existing tables fail instead of silently skipping required columns', async () => {
  const h = harness(); await h.up(); delete h.tables.get('CampaignWorkspaceSettings').accounts;
  await assert.rejects(h.up(), /incomplete schema/);
});
test('incompatible nullability and data types fail before accepting an existing schema', async () => {
  for (const patch of [{ type: 'TEXT' }, { allowNull: true }]) {
    const h = harness(); await h.up(); Object.assign(h.tables.get('CampaignWorkspaceSettings').accounts, patch);
    await assert.rejects(h.up(), /incompatible column/);
  }
});
test('nonunique workspace ownership indexes are rejected', async () => {
  const h = harness(); await h.up(); h.indexes.get('CampaignWorkspaceSettings')[0].unique = false;
  await assert.rejects(h.up(), /incompatible index/);
});
test('audit events cannot be accepted without a setting foreign key', async () => {
  const h = harness(); h.qi.getForeignKeyReferencesForTable = async () => [];
  await assert.rejects(h.up(), /missing workspace foreign key/);
});
test('rollback refuses to erase any operational authorizations', async () => {
  const h = harness(); await h.up(); h.qi.sequelize.query = async () => [[{ count: 1 }]];
  await assert.rejects(migration.down(h.qi), /explicit archival/);
  assert.equal(h.calls.some(([kind]) => kind === 'drop'), false);
});
