'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260719170000-add-web-artifact-clinic-snapshot-identity');

const LEGACY_FIELDS = ['revision_id', 'renderer_version', 'environment', 'base_url_hash', 'runtime_config_hash'];

class FakeQueryInterface {
  constructor({ duplicateLegacyTargets = false } = {}) {
    this.columns = Object.fromEntries(['id', 'artifact_hash', ...LEGACY_FIELDS].map((name) => [name, { allowNull: false }]));
    this.indexList = [{
      name: 'uniq_web_artifacts_revision_renderer_target',
      fields: LEGACY_FIELDS.map((attribute) => ({ attribute })),
      unique: true,
    }];
    this.duplicateLegacyTargets = duplicateLegacyTargets;
    this.queries = [];
    this.queryGenerator = {
      quoteTable: (value) => `\`${value}\``,
      quoteIdentifier: (value) => `\`${value}\``,
    };
    this.sequelize = {
      query: async (sql) => {
        this.queries.push(sql);
        if (/HAVING COUNT\(\*\) > 1/i.test(sql)) {
          return this.duplicateLegacyTargets ? [{ artifact_count: 2 }] : [];
        }
        if (/^SELECT/i.test(sql.trim())) return [];
        return [];
      },
    };
  }

  async describeTable() { return this.columns; }
  async showIndex() { return this.indexList; }
  async addColumn(_table, name, definition) { this.columns[name] = { ...definition }; }
  async changeColumn(_table, name, definition) { this.columns[name] = { ...definition }; }
  async removeColumn(_table, name) { delete this.columns[name]; }
  async addIndex(_table, fields, options) {
    this.indexList.push({
      name: options.name,
      fields: fields.map((attribute) => ({ attribute })),
      unique: options.unique,
    });
  }
  async removeIndex(_table, name) {
    this.indexList = this.indexList.filter((index) => index.name !== name);
  }
}

test('añade identidad por snapshot de clínica sin una ventana sin índice único', async () => {
  const queryInterface = new FakeQueryInterface();
  await migration.up(queryInterface, Sequelize);
  assert.equal(queryInterface.columns.clinic_snapshot_hash.allowNull, false);
  assert.equal(queryInterface.indexList.some((index) => index.name === 'uniq_web_artifacts_revision_renderer_target'), false);
  const target = queryInterface.indexList.find((index) => index.name === 'uniq_web_artifacts_revision_renderer_target_clinic');
  assert.equal(target.unique, true);
  assert.deepEqual(target.fields.map((field) => field.attribute), [...LEGACY_FIELDS, 'clinic_snapshot_hash']);
  assert.match(queryInterface.queries.find((sql) => /^UPDATE/i.test(sql.trim())), /SHA2\(CONCAT\('legacy:'/);

  const count = queryInterface.indexList.length;
  await migration.up(queryInterface, Sequelize);
  assert.equal(queryInterface.indexList.length, count);
});

test('rechaza un índice de destino incompatible', async () => {
  const queryInterface = new FakeQueryInterface();
  queryInterface.indexList.push({
    name: 'uniq_web_artifacts_revision_renderer_target_clinic',
    fields: [{ attribute: 'revision_id' }],
    unique: true,
  });
  await assert.rejects(
    () => migration.up(queryInterface, Sequelize),
    (error) => error.code === 'web_artifact_clinic_snapshot_index_incompatible'
  );
});

test('down falla cerrado si ya existen artefactos distintos para el mismo target antiguo', async () => {
  const queryInterface = new FakeQueryInterface({ duplicateLegacyTargets: true });
  await migration.up(queryInterface, Sequelize);
  await assert.rejects(
    () => migration.down(queryInterface, Sequelize),
    (error) => error.code === 'web_artifact_clinic_snapshot_down_blocked'
  );
  assert.ok(queryInterface.columns.clinic_snapshot_hash);
});
