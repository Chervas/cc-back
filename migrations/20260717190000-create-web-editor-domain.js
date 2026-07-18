'use strict';

const TABLES = Object.freeze([
  'WebProjects',
  'WebTemplates',
  'WebPages',
  'WebRevisions',
  'WebDrafts',
  'WebAuditEvents',
]);

const DEPENDENCIES = Object.freeze(['Clinicas', 'GruposClinicas', 'Usuarios']);

const SCOPE_TABLES = new Set(['WebProjects', 'WebTemplates', 'WebAuditEvents']);

function migrationError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function tableNameOf(value) {
  if (typeof value === 'string') return value;
  return value?.tableName || value?.table_name || value?.name || null;
}

async function tableInventory(queryInterface) {
  const tables = await queryInterface.showAllTables();
  const inventory = new Map();
  for (const value of tables) {
    const name = tableNameOf(value);
    if (!name) continue;
    const matches = inventory.get(name.toLowerCase()) || [];
    matches.push(name);
    inventory.set(name.toLowerCase(), matches);
  }
  return inventory;
}

function inventoryTableName(inventory, expectedName) {
  const matches = inventory.get(expectedName.toLowerCase()) || [];
  if (matches.length > 1) {
    throw migrationError(
      'web_editor_migration_ambiguous_table',
      `Hay varias tablas que podrían corresponder a ${expectedName}: ${matches.join(', ')}.`,
      { table: expectedName, matches }
    );
  }
  return matches[0] || null;
}

function assertCapabilities(queryInterface) {
  const required = [
    'showAllTables',
    'createTable',
    'describeTable',
    'getForeignKeyReferencesForTable',
    'showConstraint',
    'addConstraint',
    'showIndex',
    'addIndex',
  ];
  const missing = required.filter((method) => typeof queryInterface?.[method] !== 'function');
  if (missing.length) {
    throw migrationError(
      'web_editor_migration_introspection_unavailable',
      `No se puede validar de forma segura el dominio del editor web: faltan ${missing.join(', ')}.`,
      { missing_methods: missing }
    );
  }
}

function assertDependencies(inventory) {
  const missing = DEPENDENCIES.filter((name) => !inventoryTableName(inventory, name));
  if (missing.length) {
    throw migrationError(
      'web_editor_migration_missing_dependency',
      `No se puede crear el dominio del editor web; faltan tablas previas: ${missing.join(', ')}.`,
      { missing_tables: missing }
    );
  }
}

function typeKey(type) {
  const direct = type?.key || type?.constructor?.key || type?.prototype?.key;
  if (direct) return String(direct).trim().toUpperCase();
  try {
    return String(type || '').trim().toUpperCase();
  } catch (_) {
    return '';
  }
}

function typeText(type) {
  try {
    return String(type || '').trim().toUpperCase().replace(/\s+/g, ' ');
  } catch (_) {
    return typeKey(type);
  }
}

function enumValues(type) {
  const direct = type?.values || type?.options?.values;
  if (Array.isArray(direct)) return direct.map(String);
  let text;
  try {
    text = String(type || '').trim();
  } catch (_) {
    return null;
  }
  if (!/^ENUM\(/i.test(text)) return null;
  const values = [];
  const pattern = /'((?:''|\\'|[^'])*)'/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    values.push(match[1].replace(/''/g, "'").replace(/\\'/g, "'"));
  }
  return values.length ? values : null;
}

function expectedLength(type) {
  return Number(type?._length || type?.options?.length || type?.options?.size || type?.size || 0);
}

function typeMatches(actual, expected) {
  const actualText = typeText(actual);
  const expectedText = typeText(expected);
  const expectedKey = typeKey(expected);
  if (expectedKey === 'STRING') {
    const length = expectedLength(expected);
    return length
      ? new RegExp(`^(?:VAR)?CHAR\\(${length}\\)`).test(actualText)
      : /^(?:VAR)?CHAR(?:\(|$)/.test(actualText);
  }
  if (expectedKey === 'INTEGER') {
    return /^(?:INT|INTEGER)(?:\(\d+\))?(?: UNSIGNED)?$/.test(actualText);
  }
  if (expectedKey === 'BIGINT') {
    return /^BIGINT(?:\(\d+\))?(?: UNSIGNED)?$/.test(actualText);
  }
  if (expectedKey === 'ENUM') return actualText === 'ENUM' || actualText.startsWith('ENUM(');
  if (expectedKey === 'JSON') return actualText === 'JSON' || actualText === 'JSONTYPE';
  if (expectedKey === 'DATE') return /^(?:DATE|DATETIME)(?:\(\d+\))?$/.test(actualText);
  if (expectedKey === 'BOOLEAN') return /^(?:BOOLEAN|BOOL|TINYINT\(1\))$/.test(actualText);
  if (expectedKey === 'TEXT') return actualText === 'TEXT';
  return actualText === expectedText;
}

function normalizedDefault(value) {
  const raw = value && typeof value === 'object' && Object.hasOwn(value, 'val') ? value.val : value;
  if (raw === null || raw === undefined) return null;
  if (raw === false || raw === 0 || raw === '0') return '0';
  if (raw === true || raw === 1 || raw === '1') return '1';
  return String(raw)
    .trim()
    .replace(/^'(.*)'$/, '$1')
    .replace(/^CURRENT_TIMESTAMP\(\)$/i, 'CURRENT_TIMESTAMP')
    .toUpperCase();
}

function assertColumns(tableName, actual, expected) {
  const missing = Object.keys(expected).filter((column) => !Object.hasOwn(actual, column));
  if (missing.length) {
    throw migrationError(
      'web_editor_migration_incompatible_table',
      `${tableName} existe de forma parcial; faltan columnas: ${missing.join(', ')}.`,
      { table: tableName, missing_columns: missing }
    );
  }
  const mismatches = [];
  for (const [column, contract] of Object.entries(expected)) {
    const metadata = actual[column];
    if (!typeMatches(metadata?.type, contract.type)) {
      mismatches.push(`${column}:type=${typeText(metadata?.type) || 'unknown'}`);
    }
    if (metadata?.allowNull !== contract.allowNull) {
      mismatches.push(`${column}:allowNull=${String(metadata?.allowNull)}`);
    }
    if (Boolean(metadata?.primaryKey) !== Boolean(contract.primaryKey)) {
      mismatches.push(`${column}:primaryKey=${String(Boolean(metadata?.primaryKey))}`);
    }
    if (Boolean(metadata?.autoIncrement) !== Boolean(contract.autoIncrement)) {
      mismatches.push(`${column}:autoIncrement=${String(Boolean(metadata?.autoIncrement))}`);
    }
    const actualUnsigned = /\bUNSIGNED\b/.test(typeText(metadata?.type));
    const expectedUnsigned = /\bUNSIGNED\b/.test(typeText(contract.type))
      || Boolean(contract.type?._unsigned || contract.type?.options?.unsigned);
    if (actualUnsigned !== expectedUnsigned) {
      mismatches.push(`${column}:unsigned=${String(actualUnsigned)}`);
    }
    if (typeKey(contract.type) === 'ENUM') {
      const actualValues = enumValues(metadata?.type);
      const expectedValues = enumValues(contract.type);
      if (!actualValues || !expectedValues || actualValues.join(',') !== expectedValues.join(',')) {
        mismatches.push(`${column}:enum=${actualValues?.join('|') || 'unknown'}`);
      }
    }
    if (normalizedDefault(metadata?.defaultValue) !== normalizedDefault(contract.defaultValue)) {
      mismatches.push(`${column}:default=${String(metadata?.defaultValue)}`);
    }
  }
  if (mismatches.length) {
    throw migrationError(
      'web_editor_migration_incompatible_column',
      `${tableName} existe con columnas incompatibles: ${mismatches.join(', ')}.`,
      { table: tableName, mismatches }
    );
  }
}

function fieldsOf(index) {
  return (index?.fields || []).map((field) => (
    typeof field === 'string' ? field : field?.attribute || field?.name || field?.field || ''
  ));
}

async function addIndexIfMissing(queryInterface, tableName, fields, options) {
  const indexes = await queryInterface.showIndex(tableName);
  const named = indexes.filter((index) => String(index?.name || '') === options.name);
  if (named.length > 1) {
    throw migrationError(
      'web_editor_migration_incompatible_index',
      `${tableName}.${options.name} aparece más de una vez.`,
      { table: tableName, index: options.name, reason: 'duplicate_name' }
    );
  }
  if (named.length === 1) {
    const actualFields = fieldsOf(named[0]).join(',');
    if (actualFields !== fields.join(',') || Boolean(named[0].unique) !== Boolean(options.unique)) {
      throw migrationError(
        'web_editor_migration_incompatible_index',
        `${tableName}.${options.name} existe con un contrato incompatible.`,
        { table: tableName, index: options.name, expected_fields: fields, actual_fields: fieldsOf(named[0]) }
      );
    }
    return;
  }
  const aliases = indexes.filter((index) => (
    fieldsOf(index).join(',') === fields.join(',')
    && Boolean(index.unique) === Boolean(options.unique)
    && String(index?.name || '').toUpperCase() !== 'PRIMARY'
  ));
  // InnoDB creates a support index for a new single-column FK. Its
  // conventional name is the column itself, and our named index may safely
  // supersede it. Any other alias remains ambiguous and is rejected.
  const incompatibleAliases = aliases.filter((index) => !(
    fields.length === 1
    && !options.unique
    && String(index?.name || '').toLowerCase() === String(fields[0]).toLowerCase()
  ));
  if (incompatibleAliases.length) {
    throw migrationError(
      'web_editor_migration_incompatible_index',
      `${tableName} ya tiene un índice equivalente con otro nombre: ${incompatibleAliases.map((item) => item.name).join(', ')}.`,
      { table: tableName, index: options.name, aliases: incompatibleAliases.map((item) => item.name) }
    );
  }
  await queryInterface.addIndex(tableName, fields, options);
}

function normalizeCheckClause(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\\'/g, "'")
    .replace(/_[a-z0-9]+(?=')/g, '')
    .replace(/[`\s()]/g, '');
}

function rowsFromQueryResult(result) {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
}

async function getCheckConstraints(queryInterface, tableName) {
  if (queryInterface.sequelize?.query) {
    const result = await queryInterface.sequelize.query(
      `SELECT tc.CONSTRAINT_NAME AS constraint_name,
              tc.CONSTRAINT_TYPE AS constraint_type,
              cc.CHECK_CLAUSE AS check_clause
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
    LEFT JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
           ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
          AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
          AND tc.TABLE_NAME = :tableName`,
      { replacements: { tableName } }
    );
    const rows = rowsFromQueryResult(result);
    return Array.isArray(rows) ? rows : [];
  }
  const constraints = await queryInterface.showConstraint(tableName);
  return Array.isArray(constraints) ? constraints : [];
}

async function countCheckViolations(queryInterface, tableName, expression) {
  if (typeof queryInterface.countCheckViolations === 'function') {
    return Number(await queryInterface.countCheckViolations(tableName, expression));
  }
  if (queryInterface.sequelize?.query) {
    const [rows] = await queryInterface.sequelize.query(
      `SELECT COUNT(*) AS violation_count FROM \`${tableName}\` WHERE NOT (${expression})`
    );
    return Number(rows?.[0]?.violation_count || 0);
  }
  throw new Error(`No se pueden validar los datos existentes de ${tableName}`);
}

async function ensureCheckConstraint(queryInterface, Sequelize, tableName, definition) {
  const constraints = await getCheckConstraints(queryInterface, tableName);
  const named = constraints.filter((constraint) => (
    String(constraint.constraint_name || constraint.constraintName || '').toLowerCase()
      === definition.name.toLowerCase()
  ));
  if (named.length > 1) {
    throw migrationError(
      'web_editor_migration_incompatible_constraint',
      `${tableName}.${definition.name} aparece más de una vez.`,
      { table: tableName, constraint: definition.name, reason: 'duplicate_name' }
    );
  }
  if (named.length === 1) {
    const existing = named[0];
    const type = String(existing.constraint_type || existing.constraintType || 'CHECK').toUpperCase();
    const clause = existing.check_clause || existing.checkClause;
    if (type !== 'CHECK' || normalizeCheckClause(clause) !== normalizeCheckClause(definition.expression)) {
      throw migrationError(
        'web_editor_migration_incompatible_constraint',
        `${tableName}.${definition.name} existe con un contrato incompatible.`,
        { table: tableName, constraint: definition.name }
      );
    }
    return;
  }
  const aliases = constraints.filter((constraint) => {
    const type = String(constraint.constraint_type || constraint.constraintType || '').toUpperCase();
    if (type !== 'CHECK') return false;
    const clause = normalizeCheckClause(constraint.check_clause || constraint.checkClause);
    return clause.includes('scope_type') || clause.includes('clinica_id') || clause.includes('grupo_clinica_id');
  });
  if (aliases.length) {
    throw migrationError(
      'web_editor_migration_incompatible_constraint',
      `${tableName} ya tiene otro CHECK de scope y no se puede completar de forma inequívoca.`,
      {
        table: tableName,
        constraint: definition.name,
        aliases: aliases.map((item) => item.constraint_name || item.constraintName),
      }
    );
  }
  const violationCount = await countCheckViolations(queryInterface, tableName, definition.expression);
  if (violationCount > 0) {
    throw migrationError(
      'web_editor_migration_constraint_data_violation',
      `${tableName} contiene ${violationCount} fila(s) que incumplen ${definition.name}.`,
      { table: tableName, constraint: definition.name, violation_count: violationCount }
    );
  }
  await queryInterface.addConstraint(tableName, {
    fields: definition.fields,
    type: 'check',
    name: definition.name,
    where: Sequelize.literal(definition.expression),
  });
}

function actionOf(reference, kind) {
  const keys = kind === 'update'
    ? ['onUpdate', 'updateRule', 'update_rule', 'UPDATE_RULE']
    : ['onDelete', 'deleteRule', 'delete_rule', 'DELETE_RULE'];
  const value = keys.map((key) => reference?.[key]).find((item) => item != null);
  return value == null ? null : String(value).trim().toUpperCase().replace(/_/g, ' ');
}

function normalizeForeignKey(reference) {
  return {
    name: String(reference?.constraintName || reference?.constraint_name || reference?.name || ''),
    column: String(reference?.columnName || reference?.column_name || '').toLowerCase(),
    table: String(tableNameOf(
      reference?.referencedTableName || reference?.referenced_table_name || reference?.references?.table
    ) || '').toLowerCase(),
    referencedColumn: String(
      reference?.referencedColumnName
      || reference?.referenced_column_name
      || reference?.references?.field
      || ''
    ).toLowerCase(),
    onUpdate: actionOf(reference, 'update'),
    onDelete: actionOf(reference, 'delete'),
  };
}

async function queryForeignKeys(queryInterface, tableName) {
  if (queryInterface.sequelize?.query) {
    const result = await queryInterface.sequelize.query(
      `SELECT kcu.CONSTRAINT_NAME AS constraintName,
              kcu.COLUMN_NAME AS columnName,
              kcu.REFERENCED_TABLE_NAME AS referencedTableName,
              kcu.REFERENCED_COLUMN_NAME AS referencedColumnName,
              rc.UPDATE_RULE AS updateRule,
              rc.DELETE_RULE AS deleteRule
         FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
         JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
          AND rc.TABLE_NAME = kcu.TABLE_NAME
        WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
          AND kcu.TABLE_NAME = :tableName
          AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
      { replacements: { tableName } }
    );
    const rows = rowsFromQueryResult(result);
    return Array.isArray(rows) ? rows : [];
  }
  return [];
}

async function loadForeignKeys(queryInterface, tableName) {
  let references = await queryInterface.getForeignKeyReferencesForTable(tableName);
  if (!Array.isArray(references)) references = [];
  if (references.some((item) => !actionOf(item, 'update') || !actionOf(item, 'delete'))) {
    const enriched = await queryForeignKeys(queryInterface, tableName);
    if (enriched.length) references = enriched;
  }
  return references.map(normalizeForeignKey);
}

function compatibleAction(actual, expected) {
  if (actual === expected) return true;
  return ['RESTRICT', 'NO ACTION'].includes(actual) && ['RESTRICT', 'NO ACTION'].includes(expected);
}

function expectedForeignKeys(tableName, definition) {
  return Object.entries(definition).flatMap(([column, contract]) => (
    contract.references ? [{
      name: `fk_${tableName.toLowerCase()}_${column}`,
      column,
      table: tableNameOf(contract.references.model),
      referencedColumn: contract.references.key,
      onUpdate: String(contract.onUpdate || 'NO ACTION').toUpperCase(),
      onDelete: String(contract.onDelete || 'NO ACTION').toUpperCase(),
      repairableLegacyCascade: SCOPE_TABLES.has(tableName)
        && ['clinica_id', 'grupo_clinica_id'].includes(column),
    }] : []
  ));
}

function quoteMysqlIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function dialectOf(queryInterface) {
  const dialect = typeof queryInterface?.sequelize?.getDialect === 'function'
    ? queryInterface.sequelize.getDialect()
    : queryInterface?.sequelize?.options?.dialect;
  return String(dialect || '').toLowerCase();
}

async function addForeignKey(queryInterface, tableName, contract) {
  const constraints = await getCheckConstraints(queryInterface, tableName);
  const conflict = constraints.find((item) => (
    String(item.constraint_name || item.constraintName || '').toLowerCase() === contract.name.toLowerCase()
  ));
  if (conflict) {
    throw migrationError(
      'web_editor_migration_incompatible_constraint',
      `${tableName}.${contract.name} ya existe y no describe la FK esperada.`,
      { table: tableName, constraint: contract.name }
    );
  }
  await queryInterface.addConstraint(tableName, {
    fields: [contract.column],
    type: 'foreign key',
    name: contract.name,
    references: { table: contract.table, field: contract.referencedColumn },
    onUpdate: contract.onUpdate,
    onDelete: contract.onDelete,
  });
}

async function repairLegacyScopeForeignKey(queryInterface, tableName, contract, current) {
  if (typeof queryInterface?.replaceForeignKeyAtomically === 'function') {
    await queryInterface.replaceForeignKeyAtomically(tableName, current, contract);
    return;
  }
  if (dialectOf(queryInterface) !== 'mysql' || typeof queryInterface?.sequelize?.query !== 'function') {
    throw migrationError(
      'web_editor_migration_foreign_key_repair_unavailable',
      `${tableName}.${contract.column} requiere una sustitución atómica MySQL que no está disponible.`,
      { table: tableName, column: contract.column, constraint: current.name }
    );
  }
  const targetName = current.name.toLowerCase() === contract.name.toLowerCase()
    ? `${contract.name}_restrict`
    : contract.name;
  const constraints = await getCheckConstraints(queryInterface, tableName);
  const conflict = constraints.find((item) => (
    String(item.constraint_name || item.constraintName || '').toLowerCase() === targetName.toLowerCase()
  ));
  if (conflict) {
    throw migrationError(
      'web_editor_migration_incompatible_constraint',
      `${tableName}.${targetName} impide sustituir de forma inequívoca la FK legacy.`,
      { table: tableName, constraint: targetName }
    );
  }
  try {
    await queryInterface.sequelize.query([
      `ALTER TABLE ${quoteMysqlIdentifier(tableName)}`,
      `DROP FOREIGN KEY ${quoteMysqlIdentifier(current.name)},`,
      `ADD CONSTRAINT ${quoteMysqlIdentifier(targetName)}`,
      `FOREIGN KEY (${quoteMysqlIdentifier(contract.column)})`,
      `REFERENCES ${quoteMysqlIdentifier(contract.table)} (${quoteMysqlIdentifier(contract.referencedColumn)})`,
      `ON UPDATE ${contract.onUpdate} ON DELETE ${contract.onDelete}`,
    ].join(' '));
  } catch (cause) {
    const error = migrationError(
      'web_editor_migration_foreign_key_repair_failed',
      `No se pudo sustituir de forma segura la FK legacy ${tableName}.${contract.column}.`,
      { table: tableName, column: contract.column, previous_constraint: current.name }
    );
    error.cause = cause;
    throw error;
  }
}

async function ensureForeignKeys(queryInterface, tableName, definition) {
  const contracts = expectedForeignKeys(tableName, definition);
  let actual = await loadForeignKeys(queryInterface, tableName);
  for (const contract of contracts) {
    const matches = actual.filter((item) => item.column === contract.column.toLowerCase());
    if (matches.length > 1) {
      throw migrationError(
        'web_editor_migration_incompatible_foreign_key',
        `${tableName}.${contract.column} tiene varias claves foráneas.`,
        { table: tableName, column: contract.column, reason: 'ambiguous' }
      );
    }
    if (!matches.length) {
      await addForeignKey(queryInterface, tableName, contract);
      actual = await loadForeignKeys(queryInterface, tableName);
      continue;
    }
    const current = matches[0];
    const targetMatches = current.table === contract.table.toLowerCase()
      && current.referencedColumn === contract.referencedColumn.toLowerCase();
    const deleteMatches = current.onDelete && compatibleAction(current.onDelete, contract.onDelete);
    const updateMatches = current.onUpdate && compatibleAction(current.onUpdate, contract.onUpdate);
    if (targetMatches && deleteMatches && updateMatches) continue;
    if (
      contract.repairableLegacyCascade
      && targetMatches
      && deleteMatches
      && current.onUpdate === 'CASCADE'
      && contract.onUpdate === 'RESTRICT'
      && current.name
    ) {
      await repairLegacyScopeForeignKey(queryInterface, tableName, contract, current);
      actual = await loadForeignKeys(queryInterface, tableName);
      continue;
    }
    throw migrationError(
      'web_editor_migration_incompatible_foreign_key',
      `${tableName}.${contract.column} tiene una clave foránea incompatible.`,
      { table: tableName, column: contract.column, actual: current, expected: contract }
    );
  }
  const verified = await loadForeignKeys(queryInterface, tableName);
  for (const contract of contracts) {
    const current = verified.filter((item) => item.column === contract.column.toLowerCase());
    if (
      current.length !== 1
      || current[0].table !== contract.table.toLowerCase()
      || current[0].referencedColumn !== contract.referencedColumn.toLowerCase()
      || !compatibleAction(current[0].onUpdate, contract.onUpdate)
      || !compatibleAction(current[0].onDelete, contract.onDelete)
    ) {
      throw migrationError(
        'web_editor_migration_foreign_key_repair_failed',
        `La FK ${tableName}.${contract.column} no coincide tras completar el contrato.`,
        { table: tableName, column: contract.column }
      );
    }
  }
}

async function createTableIfMissing(queryInterface, tableName, definition) {
  const existingName = inventoryTableName(await tableInventory(queryInterface), tableName);
  if (!existingName) {
    await queryInterface.createTable(tableName, definition);
  } else {
    assertColumns(tableName, await queryInterface.describeTable(existingName), definition);
  }
  await ensureForeignKeys(queryInterface, existingName || tableName, definition);
}

async function assertCheckCompatibleForeignKeys(queryInterface, tableName, columns) {
  const foreignKeys = await loadForeignKeys(queryInterface, tableName);
  for (const column of columns) {
    const foreignKey = foreignKeys.find((item) => item.column === column.toLowerCase());
    if (!foreignKey || !compatibleAction(foreignKey.onUpdate, 'RESTRICT')) {
      throw migrationError(
        'web_editor_migration_incompatible_foreign_key_action',
        `${tableName}.${column} debe usar ON UPDATE RESTRICT/NO ACTION para ser compatible con CHECK.`,
        { table: tableName, column, update_rule: foreignKey?.onUpdate || null }
      );
    }
  }
}

const CLINIC_GROUP_SCOPE_CHECK = Object.freeze({
  fields: ['scope_type', 'clinica_id', 'grupo_clinica_id'],
  expression: "(scope_type = 'clinic' AND clinica_id IS NOT NULL AND grupo_clinica_id IS NULL) OR (scope_type = 'group' AND clinica_id IS NULL AND grupo_clinica_id IS NOT NULL)",
});

const GLOBAL_CLINIC_GROUP_SCOPE_CHECK = Object.freeze({
  fields: ['scope_type', 'clinica_id', 'grupo_clinica_id'],
  expression: "(scope_type = 'global' AND clinica_id IS NULL AND grupo_clinica_id IS NULL) OR (scope_type = 'clinic' AND clinica_id IS NOT NULL AND grupo_clinica_id IS NULL) OR (scope_type = 'group' AND clinica_id IS NULL AND grupo_clinica_id IS NOT NULL)",
});

const timestamps = (Sequelize, { updated = true, deleted = false } = {}) => ({
  created_at: {
    type: Sequelize.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
  ...(updated ? {
    updated_at: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
  } : {}),
  ...(deleted ? { deleted_at: { type: Sequelize.DATE, allowNull: true } } : {}),
});

const clinicScopeColumns = (Sequelize, { includeGlobal = false } = {}) => ({
  scope_type: {
    type: includeGlobal
      ? Sequelize.ENUM('global', 'clinic', 'group')
      : Sequelize.ENUM('clinic', 'group'),
    allowNull: false,
  },
  clinica_id: {
    type: Sequelize.INTEGER,
    allowNull: true,
    references: { model: 'Clinicas', key: 'id_clinica' },
    // Los IDs de scope no se renumeran. RESTRICT permite que MySQL aplique el CHECK de exclusividad (error 3823 con CASCADE).
    onUpdate: 'RESTRICT',
    onDelete: 'RESTRICT',
  },
  grupo_clinica_id: {
    type: Sequelize.INTEGER,
    allowNull: true,
    references: { model: 'GruposClinicas', key: 'id_grupo' },
    onUpdate: 'RESTRICT',
    onDelete: 'RESTRICT',
  },
});

const userForeignKey = (Sequelize, allowNull = true) => ({
  type: Sequelize.INTEGER,
  allowNull,
  references: { model: 'Usuarios', key: 'id_usuario' },
  onUpdate: 'CASCADE',
  onDelete: allowNull ? 'SET NULL' : 'RESTRICT',
});

module.exports = {
  TABLES,
  DEPENDENCIES,

  async up(queryInterface, Sequelize) {
    if (typeof queryInterface?.showAllTables !== 'function') {
      throw migrationError(
        'web_editor_migration_introspection_unavailable',
        'No se puede comprobar el inventario de tablas antes de migrar el editor web.'
      );
    }
    const inventory = await tableInventory(queryInterface);
    assertDependencies(inventory);
    assertCapabilities(queryInterface);
    await createTableIfMissing(queryInterface, 'WebProjects', {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      ...clinicScopeColumns(Sequelize),
      owner_user_id: userForeignKey(Sequelize),
      name: { type: Sequelize.STRING(191), allowNull: false },
      purpose: {
        type: Sequelize.ENUM('landing', 'microsite', 'website'),
        allowNull: false,
        defaultValue: 'landing',
      },
      locale: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'es-ES' },
      status: {
        type: Sequelize.ENUM('draft', 'active', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      created_by_user_id: userForeignKey(Sequelize),
      updated_by_user_id: userForeignKey(Sequelize),
      ...timestamps(Sequelize, { deleted: true }),
    });

    await assertCheckCompatibleForeignKeys(queryInterface, 'WebProjects', ['clinica_id', 'grupo_clinica_id']);
    await ensureCheckConstraint(queryInterface, Sequelize, 'WebProjects', {
      ...CLINIC_GROUP_SCOPE_CHECK,
      name: 'chk_web_projects_scope',
    });

    await addIndexIfMissing(queryInterface, 'WebProjects', ['clinica_id', 'status', 'deleted_at'], {
      name: 'idx_web_projects_clinic_status',
    });
    await addIndexIfMissing(queryInterface, 'WebProjects', ['grupo_clinica_id', 'status', 'deleted_at'], {
      name: 'idx_web_projects_group_status',
    });
    await addIndexIfMissing(queryInterface, 'WebProjects', ['owner_user_id', 'status'], {
      name: 'idx_web_projects_owner_status',
    });

    await createTableIfMissing(queryInterface, 'WebTemplates', {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      ...clinicScopeColumns(Sequelize, { includeGlobal: true }),
      scope_key: { type: Sequelize.STRING(64), allowNull: false },
      catalog_key: { type: Sequelize.STRING(128), allowNull: false },
      name: { type: Sequelize.STRING(191), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      category: { type: Sequelize.STRING(64), allowNull: false },
      schema_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      document: { type: Sequelize.JSON, allowNull: false },
      document_hash: { type: Sequelize.STRING(64), allowNull: false },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      compatibility: { type: Sequelize.JSON, allowNull: false },
      preview_asset_id: { type: Sequelize.INTEGER, allowNull: true },
      is_public: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      status: {
        type: Sequelize.ENUM('draft', 'active', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },
      created_by_user_id: userForeignKey(Sequelize),
      updated_by_user_id: userForeignKey(Sequelize),
      ...timestamps(Sequelize, { deleted: true }),
    });

    await assertCheckCompatibleForeignKeys(queryInterface, 'WebTemplates', ['clinica_id', 'grupo_clinica_id']);
    await ensureCheckConstraint(queryInterface, Sequelize, 'WebTemplates', {
      ...GLOBAL_CLINIC_GROUP_SCOPE_CHECK,
      name: 'chk_web_templates_scope',
    });

    await addIndexIfMissing(
      queryInterface,
      'WebTemplates',
      ['scope_key', 'catalog_key', 'version'],
      { name: 'uniq_web_templates_scope_catalog_version', unique: true }
    );
    await addIndexIfMissing(queryInterface, 'WebTemplates', ['status', 'category', 'is_public'], {
      name: 'idx_web_templates_catalog',
    });
    await addIndexIfMissing(queryInterface, 'WebTemplates', ['document_hash'], {
      name: 'idx_web_templates_document_hash',
    });

    await createTableIfMissing(queryInterface, 'WebPages', {
      // El ID estable del documento vive en page_key; este PK técnico es global.
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      project_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        references: { model: 'WebProjects', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      page_key: { type: Sequelize.STRING(64), allowNull: false },
      title: { type: Sequelize.STRING(191), allowNull: false },
      slug: { type: Sequelize.STRING(160), allowNull: false },
      parent_page_id: {
        type: Sequelize.STRING(36),
        allowNull: true,
        references: { model: 'WebPages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      template_id: {
        type: Sequelize.STRING(36),
        allowNull: true,
        references: { model: 'WebTemplates', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      position: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      seo: { type: Sequelize.JSON, allowNull: false },
      status: {
        type: Sequelize.ENUM('draft', 'active', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      created_by_user_id: userForeignKey(Sequelize),
      updated_by_user_id: userForeignKey(Sequelize),
      ...timestamps(Sequelize, { deleted: true }),
    });

    await addIndexIfMissing(queryInterface, 'WebPages', ['project_id', 'page_key'], {
      name: 'uniq_web_pages_project_key',
      unique: true,
    });
    await addIndexIfMissing(queryInterface, 'WebPages', ['project_id', 'slug'], {
      name: 'uniq_web_pages_project_slug',
      unique: true,
    });
    await addIndexIfMissing(queryInterface, 'WebPages', ['project_id', 'position', 'deleted_at'], {
      name: 'idx_web_pages_project_position',
    });
    await addIndexIfMissing(queryInterface, 'WebPages', ['parent_page_id'], {
      name: 'idx_web_pages_parent',
    });
    await addIndexIfMissing(queryInterface, 'WebPages', ['template_id'], {
      name: 'idx_web_pages_template',
    });

    await createTableIfMissing(queryInterface, 'WebRevisions', {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      project_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        references: { model: 'WebProjects', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      revision_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      schema_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      document: { type: Sequelize.JSON, allowNull: false },
      document_hash: { type: Sequelize.STRING(64), allowNull: false },
      content_snapshot: { type: Sequelize.JSON, allowNull: false },
      status: {
        type: Sequelize.ENUM('draft', 'review', 'approved', 'superseded', 'retired', 'failed'),
        allowNull: false,
        defaultValue: 'draft',
      },
      created_by_user_id: userForeignKey(Sequelize),
      submitted_by_user_id: userForeignKey(Sequelize),
      submitted_at: { type: Sequelize.DATE, allowNull: true },
      approved_by_user_id: userForeignKey(Sequelize),
      approved_at: { type: Sequelize.DATE, allowNull: true },
      ...timestamps(Sequelize, { updated: false }),
    });

    await addIndexIfMissing(queryInterface, 'WebRevisions', ['project_id', 'revision_number'], {
      name: 'uniq_web_revisions_project_number',
      unique: true,
    });
    await addIndexIfMissing(queryInterface, 'WebRevisions', ['project_id', 'status', 'created_at'], {
      name: 'idx_web_revisions_project_status',
    });
    await addIndexIfMissing(queryInterface, 'WebRevisions', ['document_hash'], {
      name: 'idx_web_revisions_document_hash',
    });

    await createTableIfMissing(queryInterface, 'WebDrafts', {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      project_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        references: { model: 'WebProjects', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      base_revision_id: {
        type: Sequelize.STRING(36),
        allowNull: true,
        references: { model: 'WebRevisions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      schema_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      document: { type: Sequelize.JSON, allowNull: false },
      document_hash: { type: Sequelize.STRING(64), allowNull: false },
      lock_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      updated_by_user_id: userForeignKey(Sequelize),
      ...timestamps(Sequelize),
    });

    await addIndexIfMissing(queryInterface, 'WebDrafts', ['project_id'], {
      name: 'uniq_web_drafts_project',
      unique: true,
    });
    await addIndexIfMissing(queryInterface, 'WebDrafts', ['base_revision_id'], {
      name: 'idx_web_drafts_base_revision',
    });

    await createTableIfMissing(queryInterface, 'WebAuditEvents', {
      id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
      project_id: {
        type: Sequelize.STRING(36),
        allowNull: true,
        references: { model: 'WebProjects', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      ...clinicScopeColumns(Sequelize, { includeGlobal: true }),
      actor_user_id: userForeignKey(Sequelize),
      event_type: { type: Sequelize.STRING(128), allowNull: false },
      entity_type: { type: Sequelize.STRING(64), allowNull: false },
      entity_id: { type: Sequelize.STRING(64), allowNull: true },
      request_id: { type: Sequelize.STRING(80), allowNull: true },
      previous_hash: { type: Sequelize.STRING(64), allowNull: true },
      next_hash: { type: Sequelize.STRING(64), allowNull: true },
      metadata: { type: Sequelize.JSON, allowNull: false },
      ...timestamps(Sequelize, { updated: false }),
    });

    await assertCheckCompatibleForeignKeys(queryInterface, 'WebAuditEvents', ['clinica_id', 'grupo_clinica_id']);
    await ensureCheckConstraint(queryInterface, Sequelize, 'WebAuditEvents', {
      ...GLOBAL_CLINIC_GROUP_SCOPE_CHECK,
      name: 'chk_web_audit_events_scope',
    });

    await addIndexIfMissing(queryInterface, 'WebAuditEvents', ['project_id', 'created_at'], {
      name: 'idx_web_audit_project_time',
    });
    await addIndexIfMissing(queryInterface, 'WebAuditEvents', ['clinica_id', 'created_at'], {
      name: 'idx_web_audit_clinic_time',
    });
    await addIndexIfMissing(queryInterface, 'WebAuditEvents', ['grupo_clinica_id', 'created_at'], {
      name: 'idx_web_audit_group_time',
    });
    await addIndexIfMissing(queryInterface, 'WebAuditEvents', ['event_type', 'created_at'], {
      name: 'idx_web_audit_event_time',
    });
    await addIndexIfMissing(queryInterface, 'WebAuditEvents', ['request_id'], {
      name: 'idx_web_audit_request',
    });
  },

  async down(queryInterface) {
    if (typeof queryInterface?.showAllTables !== 'function' || typeof queryInterface?.dropTable !== 'function') {
      throw migrationError(
        'web_editor_migration_introspection_unavailable',
        'No se puede revertir de forma segura la migración del editor web.'
      );
    }
    for (const tableName of [...TABLES].reverse()) {
      const existingName = inventoryTableName(await tableInventory(queryInterface), tableName);
      if (existingName) await queryInterface.dropTable(existingName);
    }
  },
};
