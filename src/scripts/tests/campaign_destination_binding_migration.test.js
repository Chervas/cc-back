'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260717250000-create-campaign-destination-bindings');

test('migration creates null-safe target uniqueness and per-account/event durability', async () => {
  const tables = [];
  const constraints = [];
  const indexes = [];
  const queryInterface = {
    async createTable(name, columns) { tables.push({ name, columns }); },
    async addConstraint(table, options) { constraints.push({ table, ...options }); },
    async addIndex(table, fields, options) { indexes.push({ table, fields, ...options }); },
  };
  await migration.up(queryInterface, {
    STRING: () => 'STRING', INTEGER: 'INTEGER', BIGINT: 'BIGINT', TEXT: 'TEXT', JSON: 'JSON', DATE: 'DATE',
    ENUM: (...values) => ({ values }), literal: (value) => value,
  });

  assert.deepEqual(tables.map((item) => item.name), [
    'CampaignDestinationBindings',
    'CampaignDestinationBindingAccounts',
    'CampaignDestinationBindingEvents',
  ]);
  const binding = tables[0].columns;
  assert.equal(binding.treatment_id.allowNull, true);
  assert.equal(binding.treatment_identity.allowNull, false);
  assert.equal(binding.treatment_identity.defaultValue, 0);
  assert.deepEqual(
    constraints.find((item) => item.name === 'uniq_campaign_destination_binding_target_nullsafe').fields,
    ['strategy_id', 'target_kind', 'treatment_identity']
  );
  assert.ok(constraints.some((item) => item.name === 'uniq_campaign_destination_binding_account'));
  assert.ok(constraints.some((item) => item.name === 'uniq_campaign_destination_binding_event_id'));
  assert.ok(indexes.some((item) => item.name === 'idx_campaign_destination_binding_account_state'));
});

test('migration drops event/account children before the aggregate', async () => {
  const dropped = [];
  await migration.down({ async dropTable(name) { dropped.push(name); } });
  assert.deepEqual(dropped, [
    'CampaignDestinationBindingEvents',
    'CampaignDestinationBindingAccounts',
    'CampaignDestinationBindings',
  ]);
});
