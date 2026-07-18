'use strict';

const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260717220000-create-web-artifacts');

class FakeQueryInterface {
  constructor() {
    this.tables = new Map();
    this.indexes = new Map();
  }

  async showAllTables() { return [...this.tables.keys()]; }
  async createTable(name, definition) { this.tables.set(name, definition); this.indexes.set(name, []); }
  async describeTable(name) { return this.tables.get(name); }
  async showIndex(name) { return this.indexes.get(name) || []; }
  async addIndex(name, fields, options) {
    this.indexes.get(name).push({ name: options.name, fields: fields.map((attribute) => ({ attribute })), unique: options.unique });
  }
  async dropTable(name) { this.tables.delete(name); this.indexes.delete(name); }
}

async function main() {
  const queryInterface = new FakeQueryInterface();
  await migration.up(queryInterface, Sequelize);
  const table = queryInterface.tables.get('WebArtifacts');
  assert.equal(table.project_id.references.model, 'WebProjects');
  assert.equal(table.revision_id.references.model, 'WebRevisions');
  assert.equal(table.manifest.allowNull, false);
  assert.equal(table.files.allowNull, false);
  assert.ok(queryInterface.indexes.get('WebArtifacts').some((index) => index.name === 'uniq_web_artifacts_hash' && index.unique));
  const indexCount = queryInterface.indexes.get('WebArtifacts').length;
  await migration.up(queryInterface, Sequelize);
  assert.equal(queryInterface.indexes.get('WebArtifacts').length, indexCount);

  const incompatible = new FakeQueryInterface();
  incompatible.tables.set('WebArtifacts', { id: {} });
  incompatible.indexes.set('WebArtifacts', []);
  await assert.rejects(
    () => migration.up(incompatible, Sequelize),
    (error) => error.code === 'web_artifact_migration_incompatible_table'
  );

  const wrongIndex = new FakeQueryInterface();
  await migration.up(wrongIndex, Sequelize);
  wrongIndex.indexes.get('WebArtifacts').find((index) => index.name === 'uniq_web_artifacts_hash').fields = [{ attribute: 'revision_id' }];
  await assert.rejects(
    () => migration.up(wrongIndex, Sequelize),
    (error) => error.code === 'web_artifact_migration_incompatible_index'
  );

  await migration.down(queryInterface);
  assert.equal(queryInterface.tables.has('WebArtifacts'), false);
  console.log('web artifact migration contract: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
