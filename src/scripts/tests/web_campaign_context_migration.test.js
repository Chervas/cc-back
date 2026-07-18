'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const migration = require('../../../migrations/20260717245000-add-web-project-campaign-context');

function queryInterface({ hasTable = true, column = null } = {}) {
  const calls = [];
  return {
    calls,
    showAllTables: async () => hasTable ? ['WebProjects'] : [],
    describeTable: async () => column ? { campaign_context: column } : { id: { allowNull: false } },
    addColumn: async (...args) => calls.push(['addColumn', ...args]),
    removeColumn: async (...args) => calls.push(['removeColumn', ...args]),
  };
}

test('anade campaign_context JSON nullable de forma aditiva e idempotente', async () => {
  const qi = queryInterface();
  const JSON_TYPE = { key: 'JSON' };
  await migration.up(qi, { JSON: JSON_TYPE });
  assert.equal(qi.calls.length, 1);
  assert.equal(qi.calls[0][0], 'addColumn');
  assert.equal(qi.calls[0][1], 'WebProjects');
  assert.equal(qi.calls[0][2], 'campaign_context');
  assert.equal(qi.calls[0][3].type, JSON_TYPE);
  assert.equal(qi.calls[0][3].allowNull, true);

  const existing = queryInterface({ column: { allowNull: true, type: 'JSON' } });
  await migration.up(existing, { JSON: JSON_TYPE });
  assert.equal(existing.calls.length, 0);
});

test('falla cerrado si falta WebProjects o la columna existente no es nullable', async () => {
  await assert.rejects(
    () => migration.up(queryInterface({ hasTable: false }), { JSON: {} }),
    (error) => error.code === 'web_campaign_context_migration_missing_dependency'
  );
  await assert.rejects(
    () => migration.up(queryInterface({ column: { allowNull: false, type: 'JSON' } }), { JSON: {} }),
    (error) => error.code === 'web_campaign_context_migration_incompatible_column'
  );
});
