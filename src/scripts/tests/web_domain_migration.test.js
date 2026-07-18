'use strict';

const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260717190000-create-web-editor-domain');

class FakeQueryInterface {
  constructor({ dependencies = migration.DEPENDENCIES } = {}) {
    this.dependencies = new Set(dependencies);
    this.tables = new Map();
    this.indexes = new Map();
    this.foreignKeys = new Map();
    this.constraints = new Map();
    this.createCalls = [];
    this.addIndexCalls = [];
    this.mutationCalls = [];
  }

  async showAllTables() {
    return [...this.dependencies, ...this.tables.keys()];
  }

  async createTable(tableName, definition) {
    if (this.tables.has(tableName)) throw new Error(`duplicate table ${tableName}`);
    this.tables.set(tableName, definition);
    this.indexes.set(tableName, []);
    const foreignKeys = Object.entries(definition).flatMap(([columnName, column]) => (
      column.references ? [{
        constraintName: `auto_${tableName}_${columnName}`,
        columnName,
        referencedTableName: column.references.model,
        referencedColumnName: column.references.key,
        updateRule: column.onUpdate,
        deleteRule: column.onDelete,
      }] : []
    ));
    this.foreignKeys.set(tableName, foreignKeys);
    this.constraints.set(tableName, foreignKeys.map((item) => ({
      constraintName: item.constraintName,
      constraintType: 'FOREIGN KEY',
    })));
    this.createCalls.push(tableName);
    this.mutationCalls.push(['createTable', tableName]);
  }

  async describeTable(tableName) {
    if (!this.tables.has(tableName)) throw new Error(`missing table ${tableName}`);
    return this.tables.get(tableName);
  }

  async showIndex(tableName) {
    if (!this.tables.has(tableName)) throw new Error(`missing table ${tableName}`);
    return this.indexes.get(tableName);
  }

  async addIndex(tableName, fields, options) {
    const indexes = this.indexes.get(tableName);
    if (indexes.some((index) => index.name === options.name)) {
      throw new Error(`duplicate index ${options.name}`);
    }
    const index = { fields, ...options };
    indexes.push(index);
    this.addIndexCalls.push({ tableName, ...index });
  }

  async getForeignKeyReferencesForTable(tableName) {
    return [...(this.foreignKeys.get(tableName) || [])];
  }

  async showConstraint(tableName) {
    return [...(this.constraints.get(tableName) || [])];
  }

  async getCheckConstraints(tableName) {
    return this.constraints.get(tableName) || [];
  }

  async countCheckViolations() {
    return 0;
  }

  async addConstraint(tableName, options) {
    const constraints = this.constraints.get(tableName) || [];
    if (constraints.some((constraint) => (
      (constraint.constraint_name || constraint.constraintName) === options.name
    ))) {
      throw new Error(`duplicate constraint ${options.name}`);
    }
    if (String(options.type).toLowerCase() === 'foreign key') {
      const foreignKey = {
        constraintName: options.name,
        columnName: options.fields[0],
        referencedTableName: options.references.table,
        referencedColumnName: options.references.field,
        updateRule: options.onUpdate,
        deleteRule: options.onDelete,
      };
      this.foreignKeys.get(tableName).push(foreignKey);
      constraints.push({ constraintName: options.name, constraintType: 'FOREIGN KEY' });
    } else {
      constraints.push({
        constraint_name: options.name,
        constraint_type: String(options.type).toUpperCase(),
        check_clause: options.where?.val || options.where,
      });
    }
    this.constraints.set(tableName, constraints);
    this.mutationCalls.push(['addConstraint', tableName, options.name]);
  }

  async replaceForeignKeyAtomically(tableName, current, contract) {
    const targetName = current.name.toLowerCase() === contract.name.toLowerCase()
      ? `${contract.name}_restrict`
      : contract.name;
    this.foreignKeys.set(
      tableName,
      this.foreignKeys.get(tableName).map((item) => (
        item.constraintName === current.name ? {
          constraintName: targetName,
          columnName: contract.column,
          referencedTableName: contract.table,
          referencedColumnName: contract.referencedColumn,
          updateRule: contract.onUpdate,
          deleteRule: contract.onDelete,
        } : item
      ))
    );
    this.constraints.set(
      tableName,
      this.constraints.get(tableName).map((item) => (
        item.constraintName === current.name
          ? { constraintName: targetName, constraintType: 'FOREIGN KEY' }
          : item
      ))
    );
    this.mutationCalls.push(['replaceForeignKeyAtomically', tableName, contract.column]);
  }

  async dropTable(tableName) {
    if (!this.tables.has(tableName)) throw new Error(`missing table ${tableName}`);
    this.tables.delete(tableName);
    this.indexes.delete(tableName);
    this.foreignKeys.delete(tableName);
    this.constraints.delete(tableName);
    this.mutationCalls.push(['dropTable', tableName]);
  }
}

function indexByName(queryInterface, tableName, name) {
  return queryInterface.indexes.get(tableName).find((index) => index.name === name);
}

function foreignKeyByColumn(queryInterface, tableName, columnName) {
  return queryInterface.foreignKeys.get(tableName).find((item) => item.columnName === columnName);
}

async function testMigrationIsAdditiveIdempotentAndConstrained() {
  const queryInterface = new FakeQueryInterface();
  await migration.up(queryInterface, Sequelize);
  const firstCreateCalls = queryInterface.createCalls.length;
  const firstIndexCalls = queryInterface.addIndexCalls.length;

  assert.deepEqual([...queryInterface.tables.keys()], migration.TABLES);
  assert.equal(firstCreateCalls, 6);
  assert.ok(firstIndexCalls >= 20);

  await migration.up(queryInterface, Sequelize);
  assert.equal(queryInterface.createCalls.length, firstCreateCalls);
  assert.equal(queryInterface.addIndexCalls.length, firstIndexCalls);

  const projects = queryInterface.tables.get('WebProjects');
  assert.equal(projects.clinica_id.references.model, 'Clinicas');
  assert.equal(projects.grupo_clinica_id.references.model, 'GruposClinicas');
  assert.equal(projects.owner_user_id.references.model, 'Usuarios');
  assert.equal(projects.deleted_at.allowNull, true);
  assert.equal(projects.clinica_id.onUpdate, 'RESTRICT');
  assert.equal(projects.grupo_clinica_id.onUpdate, 'RESTRICT');
  assert.ok(queryInterface.constraints.get('WebProjects').some((item) => (
    item.constraint_name === 'chk_web_projects_scope'
    && /scope_type = 'clinic'/.test(item.check_clause)
  )));

  const pages = queryInterface.tables.get('WebPages');
  assert.equal(pages.project_id.references.model, 'WebProjects');
  assert.equal(pages.parent_page_id.references.model, 'WebPages');
  assert.equal(indexByName(queryInterface, 'WebPages', 'uniq_web_pages_project_slug').unique, true);
  assert.equal(indexByName(queryInterface, 'WebPages', 'uniq_web_pages_project_key').unique, true);

  const drafts = queryInterface.tables.get('WebDrafts');
  assert.equal(drafts.base_revision_id.references.model, 'WebRevisions');
  assert.equal(indexByName(queryInterface, 'WebDrafts', 'uniq_web_drafts_project').unique, true);
  assert.equal(drafts.lock_version.defaultValue, 1);

  const revisions = queryInterface.tables.get('WebRevisions');
  assert.equal(revisions.updated_at, undefined);
  assert.equal(revisions.document.allowNull, false);
  assert.equal(revisions.document_hash.allowNull, false);
  assert.equal(revisions.content_snapshot.allowNull, false);

  const templates = queryInterface.tables.get('WebTemplates');
  assert.equal(templates.scope_key.allowNull, false);
  assert.equal(
    indexByName(queryInterface, 'WebTemplates', 'uniq_web_templates_scope_catalog_version').unique,
    true
  );
  assert.ok(queryInterface.constraints.get('WebTemplates').some((item) => (
    item.constraint_name === 'chk_web_templates_scope'
    && /scope_type = 'global'/.test(item.check_clause)
  )));

  const audit = queryInterface.tables.get('WebAuditEvents');
  assert.equal(audit.updated_at, undefined);
  assert.equal(audit.project_id.references.model, 'WebProjects');
  assert.equal(audit.metadata.allowNull, false);
  assert.ok(queryInterface.constraints.get('WebAuditEvents').some((item) => (
    item.constraint_name === 'chk_web_audit_events_scope'
  )));

  await migration.down(queryInterface);
  assert.equal(queryInterface.tables.size, 0);
  await migration.down(queryInterface);
  assert.equal(queryInterface.tables.size, 0);
}

async function testPartialIncompatibleMigrationFailsClosed() {
  const queryInterface = new FakeQueryInterface();
  queryInterface.tables.set('WebProjects', { name: { allowNull: false } });
  queryInterface.indexes.set('WebProjects', []);
  queryInterface.foreignKeys.set('WebProjects', []);
  queryInterface.constraints.set('WebProjects', []);
  await assert.rejects(
    () => migration.up(queryInterface, Sequelize),
    (error) => error.code === 'web_editor_migration_incompatible_table'
      && error.details.table === 'WebProjects'
      && error.details.missing_columns.includes('id')
  );
}

async function testIncompatibleConstraintAndIndexFailClosed() {
  const constraintQueryInterface = new FakeQueryInterface();
  await migration.up(constraintQueryInterface, Sequelize);
  constraintQueryInterface.constraints.get('WebProjects')
    .find((item) => item.constraint_name === 'chk_web_projects_scope').check_clause = 'clinica_id IS NULL';
  await assert.rejects(
    () => migration.up(constraintQueryInterface, Sequelize),
    (error) => error.code === 'web_editor_migration_incompatible_constraint'
  );

  const indexQueryInterface = new FakeQueryInterface();
  await migration.up(indexQueryInterface, Sequelize);
  indexQueryInterface.indexes.get('WebProjects')
    .find((index) => index.name === 'idx_web_projects_clinic_status').fields = ['status'];
  await assert.rejects(
    () => migration.up(indexQueryInterface, Sequelize),
    (error) => error.code === 'web_editor_migration_incompatible_index'
  );
}

async function testCascadeScopeForeignKeyIsRepairedAtomically() {
  const queryInterface = new FakeQueryInterface();
  await migration.up(queryInterface, Sequelize);
  queryInterface.foreignKeys.get('WebProjects')
    .find((item) => item.columnName === 'clinica_id').updateRule = 'CASCADE';
  await migration.up(queryInterface, Sequelize);
  assert.equal(
    queryInterface.foreignKeys.get('WebProjects')
      .find((item) => item.columnName === 'clinica_id').updateRule,
    'RESTRICT'
  );
  assert.ok(queryInterface.mutationCalls.some((call) => (
    call[0] === 'replaceForeignKeyAtomically' && call[1] === 'WebProjects' && call[2] === 'clinica_id'
  )));
}

async function testCompleteColumnContractDriftsFailClosed() {
  const cases = [
    ['string length', (query) => { query.tables.get('WebProjects').name.type = Sequelize.STRING(190); }],
    ['enum values', (query) => { query.tables.get('WebProjects').purpose.type = Sequelize.ENUM('landing'); }],
    ['nullability', (query) => { query.tables.get('WebProjects').name.allowNull = true; }],
    ['unsigned', (query) => { query.tables.get('WebProjects').version.type = Sequelize.INTEGER; }],
    ['default', (query) => { query.tables.get('WebProjects').locale.defaultValue = 'ca-ES'; }],
    ['primary key', (query) => { query.tables.get('WebProjects').id.primaryKey = false; }],
    ['auto increment', (query) => { query.tables.get('WebAuditEvents').id.autoIncrement = false; }],
  ];
  for (const [label, mutate] of cases) {
    const query = new FakeQueryInterface();
    await migration.up(query, Sequelize);
    mutate(query);
    const mutationCount = query.mutationCalls.length;
    await assert.rejects(
      () => migration.up(query, Sequelize),
      (error) => error.code === 'web_editor_migration_incompatible_column',
      label
    );
    assert.equal(query.mutationCalls.length, mutationCount, label);
  }
}

async function testCompleteForeignKeyDriftsFailClosed() {
  const cases = [
    ['target table', (query) => {
      foreignKeyByColumn(query, 'WebPages', 'project_id').referencedTableName = 'Usuarios';
    }],
    ['target column', (query) => {
      foreignKeyByColumn(query, 'WebPages', 'project_id').referencedColumnName = 'id_usuario';
    }],
    ['on delete', (query) => {
      foreignKeyByColumn(query, 'WebRevisions', 'project_id').deleteRule = 'CASCADE';
    }],
    ['non-scope on update', (query) => {
      foreignKeyByColumn(query, 'WebProjects', 'owner_user_id').updateRule = 'RESTRICT';
    }],
    ['scope cascade with wrong delete', (query) => {
      const foreignKey = foreignKeyByColumn(query, 'WebProjects', 'clinica_id');
      foreignKey.updateRule = 'CASCADE';
      foreignKey.deleteRule = 'CASCADE';
    }],
  ];
  for (const [label, mutate] of cases) {
    const query = new FakeQueryInterface();
    await migration.up(query, Sequelize);
    mutate(query);
    const mutationCount = query.mutationCalls.length;
    await assert.rejects(
      () => migration.up(query, Sequelize),
      (error) => error.code === 'web_editor_migration_incompatible_foreign_key',
      label
    );
    assert.equal(query.mutationCalls.length, mutationCount, label);
  }
}

async function testDependenciesFailBeforeDdl() {
  const query = new FakeQueryInterface({
    dependencies: migration.DEPENDENCIES.filter((name) => name !== 'Usuarios'),
  });
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'web_editor_migration_missing_dependency'
      && error.details.missing_tables.join(',') === 'Usuarios'
  );
  assert.equal(query.mutationCalls.length, 0);
}

Promise.resolve()
  .then(testMigrationIsAdditiveIdempotentAndConstrained)
  .then(testPartialIncompatibleMigrationFailsClosed)
  .then(testIncompatibleConstraintAndIndexFailClosed)
  .then(testCascadeScopeForeignKeyIsRepairedAtomically)
  .then(testCompleteColumnContractDriftsFailClosed)
  .then(testCompleteForeignKeyDriftsFailClosed)
  .then(testDependenciesFailBeforeDdl)
  .then(() => console.log('web_domain_migration.test.js: ok'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
