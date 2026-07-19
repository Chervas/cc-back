'use strict';

const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const migration = require('../../../migrations/20260719103000-create-managed-campaign-provider-executions');

const TABLE = 'ManagedCampaignProviderExecutions';
const DEPENDENCIES = Object.freeze({
  ManagedCampaigns: { id: { type: 'VARCHAR(36)', allowNull: false, primaryKey: true } },
  ManagedCampaignFundingAccounts: { id: { type: 'VARCHAR(36)', allowNull: false, primaryKey: true } },
  ManagedCampaignPublishingAudits: { id: { type: 'VARCHAR(36)', allowNull: false, primaryKey: true } },
  JobRequests: { id: { type: 'INTEGER UNSIGNED', allowNull: false, primaryKey: true } },
  Usuarios: { id_usuario: { type: 'INTEGER', allowNull: false, primaryKey: true } },
});

function mysqlType(definition) {
  const type = definition?.type;
  const key = String(type?.key || type?.constructor?.key || '').toUpperCase();
  if (Array.isArray(type?.values)) return `ENUM(${type.values.map((value) => `'${value}'`).join(',')})`;
  if (key === 'JSON') return 'JSON';
  if (key === 'DATE') return 'DATETIME';
  return String(type || 'UNKNOWN');
}

function defaultMetadata(value) {
  if (value && typeof value === 'object' && typeof value.val === 'string') {
    const [defaultValue, onUpdate = null] = value.val.split(/\s+ON\s+UPDATE\s+/i);
    return {
      defaultValue,
      extra: onUpdate ? `DEFAULT_GENERATED on update ${onUpdate}` : 'DEFAULT_GENERATED',
    };
  }
  return { defaultValue: value ?? null, extra: '' };
}

function describeColumn(definition) {
  const defaults = defaultMetadata(definition?.defaultValue);
  return {
    type: mysqlType(definition),
    allowNull: definition?.allowNull !== false,
    defaultValue: defaults.defaultValue,
    primaryKey: definition?.primaryKey === true,
    extra: defaults.extra,
  };
}

class FakeQueryInterface {
  constructor() {
    this.tables = new Map(Object.entries(DEPENDENCIES).map(([name, columns]) => [name, Object.fromEntries(
      Object.entries(columns).map(([column, definition]) => [column, { ...definition }])
    )]));
    this.foreignKeys = new Map();
    this.indexes = new Map();
    this.tableOptions = new Map([...this.tables.keys()].map((name) => [name, {
      charset: 'utf8mb4',
      collate: 'utf8mb4_0900_ai_ci',
    }]));
    this.mutations = [];
    this.sequelize = {
      query: async (sql, options = {}) => {
        if (/INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) {
          return [this.columnMetadata(options.replacements?.tableName), {}];
        }
        const foreignKeys = this.foreignKeys.get(options.replacements?.tableName || TABLE) || [];
        return [foreignKeys.map((row) => ({
          constraint_name: row.constraintName,
          column_name: row.columnName,
          referenced_table_name: row.referencedTableName,
          referenced_column_name: row.referencedColumnName,
          update_rule: row.updateAction,
          delete_rule: row.deleteAction,
        })), {}];
      },
    };
  }

  columnMetadata(name) {
    const table = this.tables.get(name) || {};
    const options = this.tableOptions.get(name) || {};
    return Object.entries(table).map(([columnName, column]) => {
      const character = /^(?:VAR)?CHAR\(|^TEXT$|^ENUM\(/i.test(column.type);
      return {
        column_name: columnName,
        column_type: column.type,
        is_nullable: column.allowNull === false ? 'NO' : 'YES',
        column_default: column.defaultValue ?? null,
        column_key: column.primaryKey ? 'PRI' : '',
        extra: column.extra || '',
        character_set_name: character ? options.charset : null,
        collation_name: character ? options.collate : null,
      };
    });
  }

  async showAllTables() { return [...this.tables.keys()]; }

  async describeTable(name) {
    if (!this.tables.has(name)) throw new Error(`missing table ${name}`);
    return this.tables.get(name);
  }

  async createTable(name, columns, options = {}) {
    if (this.tables.has(name)) throw new Error(`duplicate table ${name}`);
    this.tables.set(name, Object.fromEntries(
      Object.entries(columns).map(([column, definition]) => [column, describeColumn(definition)])
    ));
    this.foreignKeys.set(name, []);
    this.indexes.set(name, []);
    this.tableOptions.set(name, {
      charset: options.charset || 'utf8mb4',
      collate: options.collate || 'utf8mb4_0900_ai_ci',
    });
    this.mutations.push(['createTable', name]);
  }

  async addColumn(name, column, definition) {
    this.tables.get(name)[column] = describeColumn(definition);
    this.mutations.push(['addColumn', name, column]);
  }

  async changeColumn(name, column, definition) {
    this.tables.get(name)[column] = describeColumn(definition);
    this.mutations.push(['changeColumn', name, column]);
  }

  async getForeignKeyReferencesForTable(name) {
    return (this.foreignKeys.get(name) || []).map((row) => ({
      constraintName: row.constraintName,
      columnName: row.columnName,
      referencedTableName: row.referencedTableName,
      referencedColumnName: row.referencedColumnName,
    }));
  }

  async addConstraint(name, options) {
    const rows = this.foreignKeys.get(name);
    if (rows.some((row) => row.constraintName === options.name)) throw new Error(`duplicate constraint ${options.name}`);
    rows.push({
      constraintName: options.name,
      columnName: options.fields[0],
      referencedTableName: options.references.table,
      referencedColumnName: options.references.field,
      updateAction: options.onUpdate,
      deleteAction: options.onDelete,
    });
    this.mutations.push(['addConstraint', name, options.name]);
  }

  async showIndex(name) { return [...(this.indexes.get(name) || [])]; }

  async addIndex(name, fields, options) {
    const rows = this.indexes.get(name);
    if (rows.some((row) => row.name === options.name)) throw new Error(`duplicate index ${options.name}`);
    rows.push({
      name: options.name,
      unique: Boolean(options.unique),
      type: 'BTREE',
      fields: fields.map((attribute) => ({ attribute, order: 'ASC' })),
    });
    this.mutations.push(['addIndex', name, options.name]);
  }

  async dropTable(name) {
    this.tables.delete(name);
    this.foreignKeys.delete(name);
    this.indexes.delete(name);
    this.tableOptions.delete(name);
    this.mutations.push(['dropTable', name]);
  }
}

async function main() {
  const dialectBoundEnum = {
    key: 'ENUM',
    values: ['queued', 'failed'],
    toString() { throw new Error('dialect-bound ENUM must not be stringified directly'); },
  };
  assert.equal(
    migration.__testing.expectedTypeDescriptor(dialectBoundEnum),
    "ENUM('queued','failed')"
  );

  const query = new FakeQueryInterface();
  await migration.up(query, Sequelize);
  assert.equal(query.tables.has(TABLE), true);
  assert.equal(query.tables.get(TABLE).activation_job_request_id.type, 'INTEGER UNSIGNED');
  assert.equal(query.tables.get(TABLE).activation_idempotency_key.type, 'VARCHAR(191)');
  assert.equal(query.tables.get(TABLE).activation_snapshot.type, 'JSON');
  assert.equal(query.tables.get(TABLE).goal_policy_snapshot.type, 'JSON');
  assert.equal(query.tables.get(TABLE).lease_version.type, 'INTEGER UNSIGNED');
  assert.equal(query.tables.get(TABLE).lease_version.defaultValue, 0);
  assert.equal(query.tables.get(TABLE).lease_expires_at.type, 'DATETIME');
  assert.equal(query.foreignKeys.get(TABLE).length, 9);
  assert.equal(query.indexes.get(TABLE).length, 7);
  const unique = query.indexes.get(TABLE).find((index) => index.name === 'uniq_managed_provider_execution_idempotency');
  assert.equal(unique.unique, true);
  assert.deepEqual(unique.fields.map((field) => field.attribute), ['managed_campaign_id', 'idempotency_key']);

  const mutationCount = query.mutations.length;
  await migration.up(query, Sequelize);
  assert.equal(query.mutations.length, mutationCount, 'a complete rerun must not mutate schema');

  // Simulate an interruption after the original v1 table but before activation
  // columns, its FK/index and status expansion were installed.
  const columns = query.tables.get(TABLE);
  for (const column of [
    'activation_job_request_id', 'activation_idempotency_key', 'activation_change_reference',
    'activation_authorization_snapshot', 'goal_policy_snapshot', 'activation_snapshot', 'activation_requested_by_user_id',
    'activation_attempt_count', 'activation_requested_at', 'activated_at',
    'lease_version', 'lease_expires_at',
  ]) delete columns[column];
  columns.status.type = "ENUM('queued','executing','succeeded','failed','manual_recovery_required','rollback_queued','rolling_back','rolled_back','cancelled')";
  query.foreignKeys.set(TABLE, query.foreignKeys.get(TABLE).filter((row) => (
    !['activation_job_request_id', 'activation_requested_by_user_id'].includes(row.columnName)
  )));
  query.indexes.set(TABLE, query.indexes.get(TABLE).filter((index) => (
    !['idx_managed_provider_execution_activation_job', 'idx_managed_provider_execution_lease'].includes(index.name)
  )));
  await migration.up(query, Sequelize);
  assert.equal(columns.activation_job_request_id.type, 'INTEGER UNSIGNED');
  assert.equal(columns.lease_version.type, 'INTEGER UNSIGNED');
  assert.equal(columns.lease_expires_at.type, 'DATETIME');
  assert.match(columns.status.type, /'activation_queued'/);
  assert.equal(query.foreignKeys.get(TABLE).some((row) => row.columnName === 'activation_job_request_id'), true);
  assert.equal(query.foreignKeys.get(TABLE).some((row) => row.columnName === 'activation_requested_by_user_id'), true);
  assert.equal(query.indexes.get(TABLE).some((index) => index.name === 'idx_managed_provider_execution_activation_job'), true);
  assert.equal(query.indexes.get(TABLE).some((index) => index.name === 'idx_managed_provider_execution_lease'), true);
  const repairedMutationCount = query.mutations.length;
  await migration.up(query, Sequelize);
  assert.equal(query.mutations.length, repairedMutationCount, 'a repaired table must also be stable on rerun');

  const campaignFk = query.foreignKeys.get(TABLE).find((row) => row.columnName === 'managed_campaign_id');
  campaignFk.deleteAction = 'CASCADE';
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_fk'
  );
  campaignFk.deleteAction = 'RESTRICT';

  campaignFk.constraintName = 'legacy_provider_execution_campaign_fk';
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_fk'
  );
  campaignFk.constraintName = 'fk_managed_provider_execution_campaign';

  unique.unique = false;
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_index'
  );
  unique.unique = true;

  unique.fields[1].length = 16;
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_index'
  );
  delete unique.fields[1].length;

  columns.goal_policy_snapshot.type = 'VARCHAR(255)';
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_column'
  );
  columns.goal_policy_snapshot.type = 'JSON';

  columns.started_at.type = 'DATE';
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_column'
  );
  columns.started_at.type = 'DATETIME';

  columns.idempotency_key.defaultValue = 'unsafe-default';
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_column'
  );
  columns.idempotency_key.defaultValue = null;

  const expectedUpdatedExtra = columns.updated_at.extra;
  columns.updated_at.extra = '';
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_column'
  );
  columns.updated_at.extra = expectedUpdatedExtra;

  columns.activation_change_reference.allowNull = false;
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_column'
  );
  columns.activation_change_reference.allowNull = true;

  columns.id.primaryKey = false;
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_column'
  );
  columns.id.primaryKey = true;

  columns.unexpected_legacy_payload = { type: 'TEXT', allowNull: true, primaryKey: false };
  await assert.rejects(
    () => migration.up(query, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_column'
  );
  delete columns.unexpected_legacy_payload;

  const incompatibleDependency = new FakeQueryInterface();
  incompatibleDependency.tables.get('JobRequests').id.type = 'BIGINT UNSIGNED';
  await assert.rejects(
    () => migration.up(incompatibleDependency, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_dependency_type'
  );
  assert.equal(incompatibleDependency.tables.has(TABLE), false, 'dependency inventory must fail before DDL');

  const incompatibleCollation = new FakeQueryInterface();
  incompatibleCollation.tableOptions.get('ManagedCampaignFundingAccounts').collate = 'utf8mb4_bin';
  await assert.rejects(
    () => migration.up(incompatibleCollation, Sequelize),
    (error) => error.code === 'managed_provider_execution_migration_incompatible_dependency_collation'
  );
  assert.equal(incompatibleCollation.tables.has(TABLE), false, 'dependency collation must fail before DDL');

  await migration.down(query);
  await migration.down(query);
  assert.equal(query.tables.has(TABLE), false);
  console.log('managed campaign provider execution migration contract: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
