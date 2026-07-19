'use strict';

const TABLE = 'ManagedCampaignProviderExecutions';
const STATUS_VALUES = Object.freeze([
  'queued',
  'executing',
  'succeeded',
  'activation_queued',
  'activating',
  'active',
  'activation_failed',
  'failed',
  'manual_recovery_required',
  'rollback_queued',
  'rolling_back',
  'rolled_back',
  'cancelled',
]);

const FOREIGN_KEYS = Object.freeze([
  { name: 'fk_managed_provider_execution_campaign', column: 'managed_campaign_id', table: 'ManagedCampaigns', target: 'id', onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
  { name: 'fk_managed_provider_execution_funding', column: 'funding_account_id', table: 'ManagedCampaignFundingAccounts', target: 'id', onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
  { name: 'fk_managed_provider_execution_audit', column: 'source_publishing_audit_id', table: 'ManagedCampaignPublishingAudits', target: 'id', onUpdate: 'CASCADE', onDelete: 'SET NULL' },
  { name: 'fk_managed_provider_execution_job', column: 'job_request_id', table: 'JobRequests', target: 'id', onUpdate: 'CASCADE', onDelete: 'SET NULL' },
  { name: 'fk_managed_provider_execution_activation_job', column: 'activation_job_request_id', table: 'JobRequests', target: 'id', onUpdate: 'CASCADE', onDelete: 'SET NULL' },
  { name: 'fk_managed_provider_execution_rollback_job', column: 'rollback_job_request_id', table: 'JobRequests', target: 'id', onUpdate: 'CASCADE', onDelete: 'SET NULL' },
  { name: 'fk_managed_provider_execution_requested_by', column: 'requested_by_user_id', table: 'Usuarios', target: 'id_usuario', onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
  { name: 'fk_managed_provider_execution_activation_by', column: 'activation_requested_by_user_id', table: 'Usuarios', target: 'id_usuario', onUpdate: 'CASCADE', onDelete: 'SET NULL' },
  { name: 'fk_managed_provider_execution_rollback_by', column: 'rollback_requested_by_user_id', table: 'Usuarios', target: 'id_usuario', onUpdate: 'CASCADE', onDelete: 'SET NULL' },
]);

function tableNameOf(value) {
  return typeof value === 'string' ? value : value?.tableName || value?.table_name || null;
}

function rowsFromQueryResult(result) {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
}

function normalizeAction(value) {
  return String(value || '').trim().toUpperCase().replace(/_/g, ' ');
}

function actionsCompatible(actual, expected) {
  const left = normalizeAction(actual);
  const right = normalizeAction(expected);
  if (!left || !right) return false;
  if (left === right) return true;
  return ['RESTRICT', 'NO ACTION'].includes(left) && ['RESTRICT', 'NO ACTION'].includes(right);
}

function normalizeType(value) {
  return String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function expectedTypeDescriptor(value) {
  const key = String(value?.key || value?.constructor?.key || '').toUpperCase();
  if (key === 'ENUM') {
    const values = Array.isArray(value?.values)
      ? value.values
      : (Array.isArray(value?.options?.values) ? value.options.values : []);
    return `ENUM(${values.map((entry) => `'${String(entry).replace(/'/g, "''")}'`).join(',')})`;
  }
  return normalizeType(value);
}

async function tableInventory(queryInterface) {
  return (await queryInterface.showAllTables()).map(tableNameOf).filter(Boolean);
}

function columnField(row, ...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row || {}, name)) return row[name];
  }
  return undefined;
}

async function columnMetadataInventory(queryInterface, tableName) {
  if (!queryInterface.sequelize?.query) {
    const error = new Error(`${tableName} no puede verificarse sin INFORMATION_SCHEMA.COLUMNS`);
    error.code = 'managed_provider_execution_migration_column_metadata_unavailable';
    throw error;
  }
  const result = await queryInterface.sequelize.query(
    `SELECT COLUMN_NAME AS column_name,
            COLUMN_TYPE AS column_type,
            IS_NULLABLE AS is_nullable,
            COLUMN_DEFAULT AS column_default,
            COLUMN_KEY AS column_key,
            EXTRA AS extra,
            CHARACTER_SET_NAME AS character_set_name,
            COLLATION_NAME AS collation_name
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = :tableName
      ORDER BY ORDINAL_POSITION`,
    { replacements: { tableName } }
  );
  const rows = rowsFromQueryResult(result);
  if (!Array.isArray(rows) || !rows.length) {
    const error = new Error(`${tableName} no devolvió metadatos de columnas`);
    error.code = 'managed_provider_execution_migration_column_metadata_unavailable';
    throw error;
  }
  return rows;
}

async function describeTableExactly(queryInterface, tableName) {
  const description = await queryInterface.describeTable(tableName);
  const metadata = await columnMetadataInventory(queryInterface, tableName);
  const byName = new Map(metadata.map((row) => [String(columnField(row, 'columnName', 'column_name') || ''), row]));
  const missingMetadata = Object.keys(description).filter((name) => !byName.has(name));
  if (missingMetadata.length || byName.size !== Object.keys(description).length) {
    const error = new Error(`${tableName} tiene metadatos de columnas incompletos`);
    error.code = 'managed_provider_execution_migration_column_metadata_unavailable';
    error.details = { missing_columns: missingMetadata };
    throw error;
  }
  return Object.fromEntries(Object.entries(description).map(([name, described]) => {
    const row = byName.get(name);
    return [name, {
      ...described,
      type: columnField(row, 'columnType', 'column_type') || described.type,
      allowNull: String(columnField(row, 'isNullable', 'is_nullable') || '').toUpperCase() === 'YES',
      defaultValue: columnField(row, 'columnDefault', 'column_default'),
      primaryKey: String(columnField(row, 'columnKey', 'column_key') || '').toUpperCase() === 'PRI',
      extra: columnField(row, 'extra') || '',
      characterSet: columnField(row, 'characterSetName', 'character_set_name') || null,
      collation: columnField(row, 'collationName', 'collation_name') || null,
    }];
  }));
}

async function assertDependencies(queryInterface) {
  const existing = new Set(await tableInventory(queryInterface));
  const required = [
    'ManagedCampaigns',
    'ManagedCampaignFundingAccounts',
    'ManagedCampaignPublishingAudits',
    'JobRequests',
    'Usuarios',
  ];
  const missing = required.filter((name) => !existing.has(name));
  if (missing.length) {
    const error = new Error(`${TABLE} no puede crearse: faltan ${missing.join(', ')}`);
    error.code = 'managed_provider_execution_migration_missing_dependency';
    error.details = { missing_tables: missing };
    throw error;
  }
  const dependencyColumns = [
    ['ManagedCampaigns', 'id', 'string36'],
    ['ManagedCampaignFundingAccounts', 'id', 'string36'],
    ['ManagedCampaignPublishingAudits', 'id', 'string36'],
    ['JobRequests', 'id', 'uint'],
    ['Usuarios', 'id_usuario', 'int'],
  ];
  const descriptions = new Map();
  for (const [table, column, contract] of dependencyColumns) {
    const description = await describeTableExactly(queryInterface, table);
    descriptions.set(table, description);
    assertTypeContract(`${table}.${column}`, description[column], contract, 'dependency');
  }
  const stringDependencies = dependencyColumns
    .filter(([, , contract]) => contract === 'string36')
    .map(([table, column]) => descriptions.get(table)[column]);
  const charset = stringDependencies[0]?.characterSet;
  const collate = stringDependencies[0]?.collation;
  const incompatibleCollation = !charset || !collate || stringDependencies.some((column) => (
    column.characterSet !== charset || column.collation !== collate
  ));
  if (incompatibleCollation) {
    const error = new Error(`${TABLE} no puede crear FKs string con dependencias de collation incompatible`);
    error.code = 'managed_provider_execution_migration_incompatible_dependency_collation';
    throw error;
  }
  return { existing, descriptions, tableOptions: { charset, collate } };
}

function definition(Sequelize) {
  return {
    id: { type: Sequelize.STRING(36), primaryKey: true, allowNull: false },
    managed_campaign_id: { type: Sequelize.STRING(36), allowNull: false },
    funding_account_id: { type: Sequelize.STRING(36), allowNull: false },
    source_publishing_audit_id: { type: Sequelize.STRING(36), allowNull: true },
    job_request_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
    activation_job_request_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
    rollback_job_request_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
    idempotency_key: { type: Sequelize.STRING(191), allowNull: false },
    activation_idempotency_key: { type: Sequelize.STRING(191), allowNull: true },
    rollback_idempotency_key: { type: Sequelize.STRING(191), allowNull: true },
    plan_id: { type: Sequelize.STRING(191), allowNull: false },
    plan_hash: { type: Sequelize.STRING(64), allowNull: false },
    plan_snapshot: { type: Sequelize.JSON, allowNull: false },
    campaign_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
    provider: { type: Sequelize.STRING(32), allowNull: false },
    family: { type: Sequelize.STRING(64), allowNull: false },
    operation: { type: Sequelize.STRING(32), allowNull: false },
    status: { type: Sequelize.ENUM(...STATUS_VALUES), allowNull: false, defaultValue: 'queued' },
    reservation_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
    currency: { type: Sequelize.STRING(3), allowNull: false },
    change_reference: { type: Sequelize.STRING(191), allowNull: false },
    activation_change_reference: { type: Sequelize.STRING(191), allowNull: true },
    authorization_snapshot: { type: Sequelize.JSON, allowNull: false },
    provider_refs: { type: Sequelize.JSON, allowNull: false },
    ownership_snapshot: { type: Sequelize.JSON, allowNull: false },
    activation_authorization_snapshot: { type: Sequelize.JSON, allowNull: true },
    goal_policy_snapshot: { type: Sequelize.JSON, allowNull: true },
    activation_snapshot: { type: Sequelize.JSON, allowNull: true },
    rollback_snapshot: { type: Sequelize.JSON, allowNull: true },
    lease_owner: { type: Sequelize.STRING(64), allowNull: true },
    lease_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    lease_expires_at: { type: Sequelize.DATE, allowNull: true },
    requested_by_user_id: { type: Sequelize.INTEGER, allowNull: false },
    activation_requested_by_user_id: { type: Sequelize.INTEGER, allowNull: true },
    rollback_requested_by_user_id: { type: Sequelize.INTEGER, allowNull: true },
    attempt_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    activation_attempt_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    started_at: { type: Sequelize.DATE, allowNull: true },
    completed_at: { type: Sequelize.DATE, allowNull: true },
    activation_requested_at: { type: Sequelize.DATE, allowNull: true },
    activated_at: { type: Sequelize.DATE, allowNull: true },
    rolled_back_at: { type: Sequelize.DATE, allowNull: true },
    error_code: { type: Sequelize.STRING(128), allowNull: true },
    error_message: { type: Sequelize.TEXT, allowNull: true },
    created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
  };
}

function assertTypeContract(label, actual, contract, origin = 'table') {
  if (!actual) {
    const error = new Error(`${label} no existe`);
    error.code = 'managed_provider_execution_migration_missing_fk_column';
    throw error;
  }
  const type = normalizeType(actual.type);
  const valid = contract === 'string36'
    ? type === 'VARCHAR(36)'
    : contract === 'uint'
      ? /\bINT(?:EGER)?\b/.test(type) && !/BIGINT|SMALLINT|TINYINT/.test(type) && type.includes('UNSIGNED')
      : contract === 'int'
        ? /\bINT(?:EGER)?\b/.test(type) && !/BIGINT|SMALLINT|TINYINT/.test(type) && !type.includes('UNSIGNED')
        : false;
  if (!valid) {
    const error = new Error(`${label} tiene tipo incompatible (${type || 'desconocido'})`);
    error.code = origin === 'dependency'
      ? 'managed_provider_execution_migration_incompatible_dependency_type'
      : 'managed_provider_execution_migration_incompatible_fk_type';
    throw error;
  }
}

function expectedTypeMatches(actual, expected, { allowStatusSubset = false } = {}) {
  const actualType = normalizeType(actual?.type);
  const expectedType = expected?.type;
  const key = String(expectedType?.key || expectedType?.constructor?.key || '').toUpperCase();
  // A MySQL ENUM DataType can be bound/mutated by QueryInterface after the
  // CREATE TABLE statement. String(boundEnum) then calls dialect escape(),
  // which is unavailable in this post-DDL verifier. Read the public values
  // metadata instead so a fresh migration and an idempotent rerun behave alike.
  const expectedSql = expectedTypeDescriptor(expectedType);
  if (key === 'STRING') return actualType === expectedSql;
  if (key === 'INTEGER') {
    const actualUnsigned = actualType.includes('UNSIGNED');
    const expectedUnsigned = expectedSql.includes('UNSIGNED');
    return /\bINT(?:EGER)?\b/.test(actualType)
      && !/BIGINT|SMALLINT|TINYINT/.test(actualType)
      && actualUnsigned === expectedUnsigned;
  }
  if (key === 'DECIMAL') return actualType === expectedSql;
  if (key === 'JSON') return actualType === 'JSON';
  if (key === 'DATE') return actualType === 'DATETIME';
  if (key === 'TEXT') return actualType === 'TEXT';
  if (key === 'ENUM') {
    const actualValues = enumValues(actual);
    if (!actualValues) return false;
    const expectedValues = Array.isArray(expectedType.values) ? expectedType.values : [];
    return allowStatusSubset
      ? actualValues.every((value) => expectedValues.includes(value))
      : actualValues.length === expectedValues.length
        && actualValues.every((value, index) => value === expectedValues[index]);
  }
  return actualType === expectedSql;
}

function normalizeDefaultExpression(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (/^CURRENT_TIMESTAMP(?:\(\))?$/i.test(normalized)) return 'CURRENT_TIMESTAMP';
  return normalized;
}

function expectedDefaultContract(value) {
  if (value && typeof value === 'object' && typeof value.val === 'string') {
    const [defaultExpression, onUpdateExpression = null] = value.val.split(/\s+ON\s+UPDATE\s+/i);
    return {
      value: normalizeDefaultExpression(defaultExpression),
      onUpdate: normalizeDefaultExpression(onUpdateExpression),
    };
  }
  return { value: normalizeDefaultExpression(value), onUpdate: null };
}

function actualDefaultContract(actual) {
  const onUpdate = String(actual?.extra || '').match(/\bon\s+update\s+(CURRENT_TIMESTAMP(?:\(\))?)/i)?.[1] || null;
  return {
    value: normalizeDefaultExpression(actual?.defaultValue),
    onUpdate: normalizeDefaultExpression(onUpdate),
  };
}

function assertCompatibleColumn(name, actual, expected, { allowStatusSubset = false } = {}) {
  if (!actual || !expected) return;
  const typeValid = expectedTypeMatches(actual, expected, { allowStatusSubset });
  const nullabilityValid = typeof actual.allowNull === 'boolean'
    && actual.allowNull === (expected.allowNull !== false);
  const primaryKeyValid = Boolean(actual.primaryKey) === Boolean(expected.primaryKey);
  const expectedDefault = expectedDefaultContract(expected.defaultValue);
  const actualDefault = actualDefaultContract(actual);
  const defaultValid = expectedDefault.value === actualDefault.value
    && expectedDefault.onUpdate === actualDefault.onUpdate;
  if (!typeValid || !nullabilityValid || !primaryKeyValid || !defaultValid) {
    const error = new Error(`${TABLE}.${name} tiene un contrato incompatible`);
    error.code = name === 'plan_hash'
      ? 'managed_provider_execution_migration_incompatible_hash'
      : 'managed_provider_execution_migration_incompatible_column';
    error.details = {
      column: name,
      expected_type: expectedTypeDescriptor(expected.type),
      actual_type: normalizeType(actual.type),
      expected_allow_null: expected.allowNull !== false,
      actual_allow_null: actual.allowNull,
      expected_primary_key: Boolean(expected.primaryKey),
      actual_primary_key: Boolean(actual.primaryKey),
      expected_default: expectedDefault.value,
      actual_default: actualDefault.value,
      expected_on_update: expectedDefault.onUpdate,
      actual_on_update: actualDefault.onUpdate,
    };
    throw error;
  }
}

function enumValues(actual) {
  const match = String(actual?.type || '').trim().match(/^ENUM\((.*)\)$/i);
  if (!match) return null;
  return Array.from(match[1].matchAll(/'([^']+)'/g), (item) => item[1]);
}

async function createOrRepairTable(queryInterface, Sequelize, dependencyContract) {
  const columns = definition(Sequelize);
  if (!dependencyContract.existing.has(TABLE)) {
    await queryInterface.createTable(TABLE, columns, dependencyContract.tableOptions);
  }
  let actual = await describeTableExactly(queryInterface, TABLE);
  const unexpectedColumns = Object.keys(actual).filter((name) => !columns[name]);
  if (unexpectedColumns.length) {
    const error = new Error(`${TABLE} contiene columnas no declaradas: ${unexpectedColumns.join(', ')}`);
    error.code = 'managed_provider_execution_migration_incompatible_column';
    throw error;
  }
  for (const [name, column] of Object.entries(actual)) {
    if (columns[name]) assertCompatibleColumn(name, column, columns[name], { allowStatusSubset: name === 'status' });
  }
  for (const [name, column] of Object.entries(columns)) {
    if (!actual[name]) await queryInterface.addColumn(TABLE, name, column);
  }
  actual = await describeTableExactly(queryInterface, TABLE);
  const missing = Object.keys(columns).filter((name) => !actual[name]);
  if (missing.length) {
    const error = new Error(`${TABLE} sigue incompleta: faltan ${missing.join(', ')}`);
    error.code = 'managed_provider_execution_migration_incomplete_table';
    throw error;
  }
  for (const [name, column] of Object.entries(actual)) {
    if (columns[name]) assertCompatibleColumn(name, column, columns[name], { allowStatusSubset: name === 'status' });
  }
  const currentStatuses = enumValues(actual.status);
  if (!currentStatuses) {
    const error = new Error(`${TABLE}.status no es ENUM`);
    error.code = 'managed_provider_execution_migration_incompatible_status';
    throw error;
  }
  const unknownStatuses = currentStatuses.filter((status) => !STATUS_VALUES.includes(status));
  if (unknownStatuses.length) {
    const error = new Error(`${TABLE}.status contiene valores desconocidos: ${unknownStatuses.join(', ')}`);
    error.code = 'managed_provider_execution_migration_incompatible_status';
    throw error;
  }
  if (STATUS_VALUES.some((status) => !currentStatuses.includes(status))) {
    await queryInterface.changeColumn(TABLE, 'status', columns.status);
  }
  actual = await describeTableExactly(queryInterface, TABLE);
  for (const [name, expected] of Object.entries(columns)) {
    assertCompatibleColumn(name, actual[name], expected, { allowStatusSubset: false });
  }
  for (const spec of FOREIGN_KEYS) {
    const parent = dependencyContract.descriptions.get(spec.table)?.[spec.target];
    const child = actual[spec.column];
    if (parent?.characterSet && (
      child?.characterSet !== parent.characterSet || child?.collation !== parent.collation
    )) {
      const error = new Error(`${TABLE}.${spec.column} no comparte charset/collation con ${spec.table}.${spec.target}`);
      error.code = 'managed_provider_execution_migration_incompatible_fk_collation';
      throw error;
    }
  }
}

async function foreignKeyInventory(queryInterface) {
  let references = [];
  if (typeof queryInterface.getForeignKeyReferencesForTable === 'function') {
    references = await queryInterface.getForeignKeyReferencesForTable(TABLE);
    if (!Array.isArray(references)) references = [];
  }
  const hasExactActions = references.every((row) => (
    foreignKeyField(row, 'columnName', 'column_name')
    && foreignKeyField(row, 'referencedTableName', 'referenced_table_name', 'tableName', 'table_name')
    && foreignKeyField(row, 'referencedColumnName', 'referenced_column_name')
    && foreignKeyField(row, 'updateAction', 'update_rule')
    && foreignKeyField(row, 'deleteAction', 'delete_rule')
  ));
  if (references.length && hasExactActions) return references;
  if (!queryInterface.sequelize?.query) return references;
  const result = await queryInterface.sequelize.query(
    `SELECT kcu.CONSTRAINT_NAME AS constraint_name,
            kcu.COLUMN_NAME AS column_name,
            kcu.REFERENCED_TABLE_NAME AS referenced_table_name,
            kcu.REFERENCED_COLUMN_NAME AS referenced_column_name,
            rc.UPDATE_RULE AS update_rule,
            rc.DELETE_RULE AS delete_rule
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        AND rc.TABLE_NAME = kcu.TABLE_NAME
      WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
        AND kcu.TABLE_NAME = :tableName
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
    { replacements: { tableName: TABLE } }
  );
  const rows = rowsFromQueryResult(result);
  return Array.isArray(rows) && rows.length ? rows : references;
}

function foreignKeyField(row, ...names) {
  for (const name of names) {
    if (row?.[name] !== undefined && row?.[name] !== null) return row[name];
  }
  return null;
}

async function ensureForeignKeys(queryInterface) {
  let inventory = await foreignKeyInventory(queryInterface);
  for (const row of inventory) {
    const column = String(foreignKeyField(row, 'columnName', 'column_name') || '');
    const name = String(foreignKeyField(row, 'constraintName', 'constraint_name') || '');
    const spec = FOREIGN_KEYS.find((candidate) => candidate.column === column);
    if (!spec || name.toLowerCase() !== spec.name.toLowerCase()) {
      const error = new Error(`${TABLE}.${column || name || 'foreign_key'} tiene una FK no declarada o con nombre incompatible`);
      error.code = 'managed_provider_execution_migration_incompatible_fk';
      throw error;
    }
  }
  for (const spec of FOREIGN_KEYS) {
    const namedConflicts = inventory.filter((row) => (
      String(foreignKeyField(row, 'constraintName', 'constraint_name') || '').toLowerCase()
        === spec.name.toLowerCase()
      && String(foreignKeyField(row, 'columnName', 'column_name') || '') !== spec.column
    ));
    if (namedConflicts.length) {
      const error = new Error(`${TABLE}.${spec.name} ya identifica otra FK`);
      error.code = 'managed_provider_execution_migration_incompatible_fk';
      throw error;
    }
    const matches = inventory.filter((row) => String(foreignKeyField(row, 'columnName', 'column_name') || '') === spec.column);
    if (matches.length) {
      const compatible = matches.length === 1
        && String(foreignKeyField(matches[0], 'constraintName', 'constraint_name') || '').toLowerCase() === spec.name.toLowerCase()
        && String(foreignKeyField(matches[0], 'referencedTableName', 'referenced_table_name', 'tableName', 'table_name') || '') === spec.table
        && String(foreignKeyField(matches[0], 'referencedColumnName', 'referenced_column_name') || '') === spec.target
        && actionsCompatible(foreignKeyField(matches[0], 'updateAction', 'update_rule'), spec.onUpdate)
        && actionsCompatible(foreignKeyField(matches[0], 'deleteAction', 'delete_rule'), spec.onDelete);
      if (!compatible) {
        const error = new Error(`${TABLE}.${spec.column} tiene una FK incompatible`);
        error.code = 'managed_provider_execution_migration_incompatible_fk';
        throw error;
      }
      continue;
    }
    await queryInterface.addConstraint(TABLE, {
      fields: [spec.column],
      type: 'foreign key',
      name: spec.name,
      references: { table: spec.table, field: spec.target },
      onUpdate: spec.onUpdate,
      onDelete: spec.onDelete,
    });
    inventory = await foreignKeyInventory(queryInterface);
  }
  if (inventory.length !== FOREIGN_KEYS.length) {
    const error = new Error(`${TABLE} no conserva el inventario exacto de FKs`);
    error.code = 'managed_provider_execution_migration_incompatible_fk';
    throw error;
  }
}

async function ensureIndex(queryInterface, name, fields, unique = false) {
  const indexes = await queryInterface.showIndex(TABLE);
  const existing = indexes.find((index) => index.name === name);
  if (existing) {
    const indexFields = existing.fields || [];
    const actualFields = indexFields.map((field) => field.attribute || field.name || field.column);
    const actualUnique = existing.unique !== undefined
      ? Boolean(existing.unique)
      : existing.nonUnique !== undefined
        ? Number(existing.nonUnique) === 0
        : false;
    const noPrefixes = indexFields.every((field) => field.length === undefined || field.length === null);
    const ascending = indexFields.every((field) => !field.order || String(field.order).toUpperCase() === 'ASC');
    const btree = String(existing.type || '').toUpperCase() === 'BTREE';
    if (actualFields.join(',') !== fields.join(',')
      || actualUnique !== Boolean(unique)
      || !noPrefixes
      || !ascending
      || !btree) {
      const error = new Error(`${TABLE}.${name} existe con un contrato incompatible`);
      error.code = 'managed_provider_execution_migration_incompatible_index';
      throw error;
    }
    return;
  }
  await queryInterface.addIndex(TABLE, fields, { name, unique });
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const dependencyContract = await assertDependencies(queryInterface);
    await createOrRepairTable(queryInterface, Sequelize, dependencyContract);
    await ensureForeignKeys(queryInterface);
    await ensureIndex(queryInterface, 'uniq_managed_provider_execution_idempotency', ['managed_campaign_id', 'idempotency_key'], true);
    await ensureIndex(queryInterface, 'idx_managed_provider_execution_campaign_status', ['managed_campaign_id', 'status', 'created_at']);
    await ensureIndex(queryInterface, 'idx_managed_provider_execution_job', ['job_request_id']);
    await ensureIndex(queryInterface, 'idx_managed_provider_execution_activation_job', ['activation_job_request_id']);
    await ensureIndex(queryInterface, 'idx_managed_provider_execution_rollback_job', ['rollback_job_request_id']);
    await ensureIndex(queryInterface, 'idx_managed_provider_execution_plan_hash', ['plan_hash']);
    await ensureIndex(queryInterface, 'idx_managed_provider_execution_lease', ['status', 'lease_expires_at']);
  },

  async down(queryInterface) {
    const existing = new Set(await tableInventory(queryInterface));
    if (existing.has(TABLE)) await queryInterface.dropTable(TABLE);
  },

  __testing: {
    STATUS_VALUES,
    definition,
    enumValues,
    expectedDefaultContract,
    expectedTypeDescriptor,
    normalizeAction,
    normalizeDefaultExpression,
    normalizeType,
  },
};
