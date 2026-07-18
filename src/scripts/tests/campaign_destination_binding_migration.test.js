'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../../../migrations/20260717250000-create-campaign-destination-bindings');

const sequelizeTypes = {
  STRING: () => 'STRING', INTEGER: 'INTEGER', BIGINT: 'BIGINT', TEXT: 'TEXT', JSON: 'JSON', DATE: 'DATE',
  ENUM: (...values) => `ENUM(${values.join(',')})`, literal: (value) => value,
};

test('migration creates null-safe target uniqueness and per-account/event durability', async () => {
  const dependencies = [
    'Campaigns', 'Tratamientos', 'Clinicas', 'GruposClinicas', 'WebProjects',
    'WebPublications', 'WebRevisions', 'WebArtifacts', 'ManagedCampaigns', 'JobRequests',
  ];
  const tables = [];
  const indexes = [];
  const queryInterface = {
    async showAllTables() { return dependencies.concat(tables.map((item) => item.name)); },
    async createTable(name, columns) { tables.push({ name, columns }); },
    async describeTable(name) { return tables.find((item) => item.name === name)?.columns || {}; },
    async getForeignKeyReferencesForTable(name) {
      const columns = tables.find((item) => item.name === name)?.columns || {};
      return Object.entries(columns).flatMap(([columnName, definition]) => definition.references ? [{
        columnName,
        referencedTableName: definition.references.model,
        referencedColumnName: definition.references.key,
      }] : []);
    },
    async showIndex(table) { return indexes.filter((item) => item.table === table); },
    async addIndex(table, fields, options) { indexes.push({ table, fields, ...options }); },
  };
  await migration.up(queryInterface, sequelizeTypes);

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
    indexes.find((item) => item.name === 'uniq_campaign_destination_binding_target_nullsafe').fields,
    ['strategy_id', 'target_kind', 'treatment_identity']
  );
  assert.ok(indexes.some((item) => item.name === 'uniq_campaign_destination_binding_account' && item.unique));
  assert.ok(indexes.some((item) => item.name === 'uniq_campaign_destination_binding_event_id' && item.unique));
  assert.ok(indexes.some((item) => item.name === 'idx_campaign_destination_binding_account_state'));

  const indexCount = indexes.length;
  await migration.up(queryInterface, sequelizeTypes);
  assert.equal(tables.length, 3, 'a resumed migration must not recreate completed tables');
  assert.equal(indexes.length, indexCount, 'a resumed migration must not recreate completed indexes');
});

test('migration fails before DDL when a required web dependency is missing', async () => {
  let createCalls = 0;
  await assert.rejects(
    migration.up({
      async showAllTables() {
        return ['Campaigns', 'Tratamientos', 'Clinicas', 'GruposClinicas', 'ManagedCampaigns', 'JobRequests'];
      },
      async createTable() { createCalls += 1; },
    }, sequelizeTypes),
    /faltan tablas previas: WebProjects, WebPublications, WebRevisions, WebArtifacts/
  );
  assert.equal(createCalls, 0);
});

test('migration refuses an ambiguous partially-created parent table', async () => {
  const dependencies = [
    'Campaigns', 'Tratamientos', 'Clinicas', 'GruposClinicas', 'WebProjects',
    'WebPublications', 'WebRevisions', 'WebArtifacts', 'ManagedCampaigns', 'JobRequests',
    'CampaignDestinationBindings',
  ];
  await assert.rejects(
    migration.up({
      async showAllTables() { return dependencies; },
      async describeTable() { return { id: { type: 'VARCHAR(36)', allowNull: false } }; },
    }, sequelizeTypes),
    /creado de forma parcial; faltan columnas/
  );
});

test('migration drops event/account children before the aggregate', async () => {
  const existing = [
    'CampaignDestinationBindings',
    'CampaignDestinationBindingAccounts',
    'CampaignDestinationBindingEvents',
  ];
  const dropped = [];
  await migration.down({
    async showAllTables() { return existing.filter((name) => !dropped.includes(name)); },
    async dropTable(name) { dropped.push(name); },
  });
  assert.deepEqual(dropped, [
    'CampaignDestinationBindingEvents',
    'CampaignDestinationBindingAccounts',
    'CampaignDestinationBindings',
  ]);
});
