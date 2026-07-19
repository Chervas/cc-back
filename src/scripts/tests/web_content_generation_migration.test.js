'use strict';

const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260719113000-create-web-content-generations');

const DEPENDENCIES = ['Clinicas', 'GruposClinicas', 'Usuarios', 'JobRequests', 'WebContentEntries'];

function referenceRows(columns) {
  return Object.entries(columns).flatMap(([column, definition]) => {
    if (!definition.references) return [];
    return [{
      constraint_name: `auto_${column}`,
      column_name: column,
      referenced_table_name: definition.references.model,
      referenced_column_name: definition.references.key,
      update_rule: definition.onUpdate,
      delete_rule: definition.onDelete,
    }];
  });
}

class FakeQueryInterface {
  constructor() {
    this.tables = new Map(DEPENDENCIES.map((name) => [name, { id: {} }]));
    this.indexes = new Map();
    this.checks = new Map();
    this.foreignKeys = new Map();
    this.sequelize = {
      query: async (sql, options = {}) => {
        const table = options.replacements?.tableName;
        if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')) {
          return [this.foreignKeys.get(table) || [], {}];
        }
        if (sql.includes('INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) {
          return [this.checks.get(table) || [], {}];
        }
        if (sql.includes('violation_count')) return [[{ violation_count: 0 }], {}];
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
  }

  async showAllTables() { return [...this.tables.keys()]; }
  async createTable(name, columns) {
    this.tables.set(name, { ...columns });
    this.indexes.set(name, []);
    this.checks.set(name, []);
    this.foreignKeys.set(name, referenceRows(columns));
  }
  async describeTable(name) { return this.tables.get(name); }
  async addColumn(name, column, definition) { this.tables.get(name)[column] = definition; }
  async showIndex(name) { return this.indexes.get(name) || []; }
  async addIndex(name, fields, options) {
    this.indexes.get(name).push({
      name: options.name,
      unique: Boolean(options.unique),
      fields: fields.map((attribute) => ({ attribute })),
    });
  }
  async addConstraint(name, options) {
    if (options.type === 'foreign key') {
      this.foreignKeys.get(name).push({
        constraint_name: options.name,
        column_name: options.fields[0],
        referenced_table_name: options.references.table,
        referenced_column_name: options.references.field,
        update_rule: options.onUpdate,
        delete_rule: options.onDelete,
      });
      return;
    }
    this.checks.get(name).push({
      constraint_name: options.name,
      constraint_type: String(options.type || '').toUpperCase(),
      check_clause: options.where?.val || String(options.where || ''),
    });
  }
  async dropTable(name) {
    this.tables.delete(name);
    this.indexes.delete(name);
    this.checks.delete(name);
    this.foreignKeys.delete(name);
  }
}

async function main() {
  const dialectBoundEnum = {
    key: 'ENUM',
    values: ['clinic', 'group'],
    toString() { throw new Error('dialect-bound ENUM must not be stringified directly'); },
  };
  assert.doesNotThrow(() => migration.__testing.assertColumnCompatible(
    'WebContentGenerations',
    'scope_type',
    { type: "ENUM('clinic','group')", allowNull: false },
    { type: dialectBoundEnum, allowNull: false }
  ));

  const queryInterface = new FakeQueryInterface();
  await migration.up(queryInterface, Sequelize);

  const generationTable = queryInterface.tables.get('WebContentGenerations');
  const quotaTable = queryInterface.tables.get('WebContentGenerationQuotaBuckets');
  assert.equal(String(generationTable.job_request_id.type), 'INTEGER UNSIGNED');
  assert.equal(generationTable.job_request_id.references.model, 'JobRequests');
  assert.equal(String(generationTable.idempotency_key_hash.type), 'VARCHAR(64)');
  assert.equal(String(generationTable.execution_attempt_token_hash.type), 'VARCHAR(64)');
  assert.equal(generationTable.execution_attempt_token_hash.allowNull, true);
  assert.equal(String(quotaTable.request_count.type), 'INTEGER UNSIGNED');
  assert.equal(quotaTable.bucket_key_hash.primaryKey, true);
  assert.ok(queryInterface.indexes.get('WebContentGenerations').some((index) => (
    index.name === 'uniq_web_content_generations_idempotency' && index.unique
  )));
  assert.ok(queryInterface.indexes.get('WebContentGenerationQuotaBuckets').some((index) => (
    index.name === 'idx_web_content_generation_quota_expires'
  )));

  const counts = {
    generationIndexes: queryInterface.indexes.get('WebContentGenerations').length,
    quotaIndexes: queryInterface.indexes.get('WebContentGenerationQuotaBuckets').length,
    checks: queryInterface.checks.get('WebContentGenerations').length,
    foreignKeys: queryInterface.foreignKeys.get('WebContentGenerations').length,
  };

  // MySQL prefixes literals in INFORMATION_SCHEMA.CHECK_CONSTRAINTS. A rerun
  // must recognize the same clause instead of failing after partial DDL.
  queryInterface.checks.get('WebContentGenerations')[0].check_clause = (
    "((`scope_type` = _utf8mb4'clinic') AND (`clinica_id` IS NOT NULL) AND (`grupo_clinica_id` IS NULL)) "
    + "OR ((`scope_type` = _utf8mb4'group') AND (`clinica_id` IS NULL) AND (`grupo_clinica_id` IS NOT NULL))"
  );
  await migration.up(queryInterface, Sequelize);
  assert.equal(queryInterface.indexes.get('WebContentGenerations').length, counts.generationIndexes);
  assert.equal(queryInterface.indexes.get('WebContentGenerationQuotaBuckets').length, counts.quotaIndexes);
  assert.equal(queryInterface.checks.get('WebContentGenerations').length, counts.checks);
  assert.equal(queryInterface.foreignKeys.get('WebContentGenerations').length, counts.foreignKeys);

  // Simulate a crash in the middle of compatible column/FK/index DDL. Reentry
  // repairs only the missing contracts and preserves all completed work.
  delete generationTable.proposal_hash;
  queryInterface.foreignKeys.set(
    'WebContentGenerations',
    queryInterface.foreignKeys.get('WebContentGenerations').filter((item) => item.column_name !== 'job_request_id')
  );
  queryInterface.indexes.set(
    'WebContentGenerations',
    queryInterface.indexes.get('WebContentGenerations').filter((item) => item.name !== 'uniq_web_content_generations_job')
  );
  await migration.up(queryInterface, Sequelize);
  assert.ok(generationTable.proposal_hash);
  assert.ok(queryInterface.foreignKeys.get('WebContentGenerations').some((item) => (
    item.column_name === 'job_request_id'
    && item.referenced_table_name === 'JobRequests'
    && item.update_rule === 'CASCADE'
    && item.delete_rule === 'SET NULL'
  )));
  assert.ok(queryInterface.indexes.get('WebContentGenerations').some((item) => (
    item.name === 'uniq_web_content_generations_job' && item.unique
  )));

  generationTable.job_request_id.type = Sequelize.BIGINT.UNSIGNED;
  await assert.rejects(
    () => migration.up(queryInterface, Sequelize),
    (error) => error.code === 'web_content_generation_migration_incompatible_column'
  );
  generationTable.job_request_id.type = Sequelize.INTEGER.UNSIGNED;

  const originalStatusType = generationTable.status.type;
  generationTable.status.type = "ENUM('queued','running','completed','accepted','failed','unexpected')";
  await assert.rejects(
    () => migration.up(queryInterface, Sequelize),
    (error) => error.code === 'web_content_generation_migration_incompatible_column'
  );
  generationTable.status.type = "ENUM('running','queued','completed','accepted','failed')";
  await assert.rejects(
    () => migration.up(queryInterface, Sequelize),
    (error) => error.code === 'web_content_generation_migration_incompatible_column'
  );
  generationTable.status.type = originalStatusType;

  const jobFk = queryInterface.foreignKeys.get('WebContentGenerations').find((item) => (
    item.column_name === 'job_request_id'
  ));
  jobFk.delete_rule = 'CASCADE';
  await assert.rejects(
    () => migration.up(queryInterface, Sequelize),
    (error) => error.code === 'web_content_generation_migration_incompatible_foreign_key'
  );
  jobFk.delete_rule = 'SET NULL';

  queryInterface.checks.get('WebContentGenerations')[0].check_clause = null;
  await assert.rejects(
    () => migration.up(queryInterface, Sequelize),
    (error) => error.code === 'web_content_generation_migration_incompatible_check'
  );

  await migration.down(queryInterface);
  await migration.down(queryInterface);
  assert.equal(queryInterface.tables.has('WebContentGenerations'), false);
  assert.equal(queryInterface.tables.has('WebContentGenerationQuotaBuckets'), false);
  console.log('web content generation migration contract: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
