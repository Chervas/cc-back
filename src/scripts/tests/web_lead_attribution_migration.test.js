'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260717240000-add-web-attribution-to-lead-intakes');

function queryInterface() {
  const dependencies = ['WebProjects', 'WebRevisions', 'WebPages', 'WebPublications', 'WebArtifacts'];
  const tables = new Map([
    ['LeadIntakes', { created_at: { type: 'DATETIME', allowNull: false } }],
    ...dependencies.map((name) => [name, { id: { type: 'VARCHAR(36)', allowNull: false } }]),
  ]);
  const indexes = [];
  const calls = [];
  return {
    tables,
    indexes,
    calls,
    async showAllTables() { return [...tables.keys()]; },
    async describeTable(name) { return tables.get(name) || {}; },
    async addColumn(name, column, definition) {
      tables.get(name)[column] = { ...definition, type: String(definition.type) };
    },
    async removeColumn(name, column) {
      calls.push(['removeColumn', column]);
      delete tables.get(name)[column];
    },
    async showIndex() { return indexes; },
    async addIndex(name, fields, options) {
      indexes.push({ name: options.name, unique: Boolean(options.unique), fields: fields.map((attribute) => ({ attribute })) });
    },
    async removeIndex(name, indexName) {
      const target = indexes.find((item) => item.name === indexName);
      const liveColumns = tables.get(name);
      if (target?.fields[0] && liveColumns[target.fields[0].attribute]) {
        const error = new Error('Cannot drop index needed in a foreign key constraint');
        error.errno = 1553;
        throw error;
      }
      calls.push(['removeIndex', indexName]);
      const index = indexes.findIndex((item) => item.name === indexName);
      if (index >= 0) indexes.splice(index, 1);
    },
  };
}

test('añade atribución web nullable, FKs e índices y es idempotente', async () => {
  const qi = queryInterface();
  await migration.up(qi, Sequelize);
  const lead = qi.tables.get('LeadIntakes');
  assert.match(lead.web_project_id.type, /VARCHAR\(36\)/i);
  assert.equal(lead.web_project_id.references.model, 'WebProjects');
  assert.match(lead.web_form_id.type, /VARCHAR\(64\)/i);
  assert.equal(qi.indexes.length, 3);
  await migration.up(qi, Sequelize);
  assert.equal(qi.indexes.length, 3);
});

test('falla cerrado ante dependencia, columna o índice incompatible', async () => {
  const missing = queryInterface();
  missing.tables.delete('WebArtifacts');
  await assert.rejects(() => migration.up(missing, Sequelize), (error) => error.code === 'web_lead_attribution_migration_missing_dependency');

  const wrongColumn = queryInterface();
  wrongColumn.tables.get('LeadIntakes').web_project_id = { type: 'VARCHAR(64)', allowNull: true };
  await assert.rejects(() => migration.up(wrongColumn, Sequelize), (error) => error.code === 'web_lead_attribution_migration_incompatible_column');

  const wrongIndex = queryInterface();
  await migration.up(wrongIndex, Sequelize);
  wrongIndex.indexes[0].unique = true;
  await assert.rejects(() => migration.up(wrongIndex, Sequelize), (error) => error.code === 'web_lead_attribution_migration_incompatible_index');
});

test('down retira únicamente el contrato de esta migración', async () => {
  const qi = queryInterface();
  await migration.up(qi, Sequelize);
  await migration.down(qi);
  assert.equal(qi.tables.get('LeadIntakes').web_project_id, undefined);
  assert.equal(qi.tables.get('LeadIntakes').created_at.allowNull, false);
  assert.equal(qi.indexes.length, 0);
  const firstIndexRemoval = qi.calls.findIndex(([operation]) => operation === 'removeIndex');
  const lastColumnRemoval = qi.calls.map(([operation]) => operation).lastIndexOf('removeColumn');
  assert.ok(firstIndexRemoval > lastColumnRemoval, 'all FK columns must be removed before dependent indexes');

  const callsAfterFirstDown = qi.calls.length;
  await migration.down(qi);
  assert.equal(qi.calls.length, callsAfterFirstDown, 'down must be idempotent');
});

test('down no hace nada si LeadIntakes ya no existe', async () => {
  const qi = queryInterface();
  qi.tables.delete('LeadIntakes');
  await migration.down(qi);
  assert.deepEqual(qi.calls, []);
});
