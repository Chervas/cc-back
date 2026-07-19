'use strict';

const TABLES = Object.freeze([
  'WebContentGenerations',
  'WebContentGenerationQuotaBuckets',
]);
const DEPENDENCIES = Object.freeze([
  'Clinicas',
  'GruposClinicas',
  'Usuarios',
  'JobRequests',
  'WebContentEntries',
]);
const SCOPE_CHECK = "((scope_type = 'clinic' AND clinica_id IS NOT NULL AND grupo_clinica_id IS NULL) OR (scope_type = 'group' AND clinica_id IS NULL AND grupo_clinica_id IS NOT NULL))";

const INDEX_CONTRACTS = Object.freeze({
  WebContentGenerations: Object.freeze([
    { name: 'idx_web_content_generations_clinic_created', fields: ['clinica_id', 'created_at'] },
    { name: 'idx_web_content_generations_group_created', fields: ['grupo_clinica_id', 'created_at'] },
    { name: 'idx_web_content_generations_status_expires', fields: ['status', 'expires_at'] },
    { name: 'idx_web_content_generations_input_hash', fields: ['input_hash'] },
    { name: 'uniq_web_content_generations_idempotency', fields: ['idempotency_key_hash'], unique: true },
    { name: 'uniq_web_content_generations_job', fields: ['job_request_id'], unique: true },
    { name: 'uniq_web_content_generations_accepted_content', fields: ['accepted_content_entry_id'], unique: true },
  ]),
  WebContentGenerationQuotaBuckets: Object.freeze([
    { name: 'idx_web_content_generation_quota_expires', fields: ['expires_at'] },
    { name: 'idx_web_content_generation_quota_type_start', fields: ['bucket_type', 'bucket_start'] },
  ]),
});

function migrationError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function tableNameOf(value) {
  return typeof value === 'string'
    ? value
    : value?.tableName || value?.table_name || value?.name || null;
}

async function tableInventory(queryInterface) {
  const inventory = new Map();
  for (const value of await queryInterface.showAllTables()) {
    const name = tableNameOf(value);
    if (!name) continue;
    const key = name.toLowerCase();
    const matches = inventory.get(key) || [];
    matches.push(name);
    inventory.set(key, matches);
  }
  return inventory;
}

function inventoryTableName(inventory, expected) {
  const matches = inventory.get(expected.toLowerCase()) || [];
  if (matches.length > 1) {
    throw migrationError(
      'web_content_generation_migration_ambiguous_table',
      `Hay varias tablas que podrían corresponder a ${expected}: ${matches.join(', ')}.`
    );
  }
  return matches[0] || null;
}

function rowsFromQueryResult(result) {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
}

function normalizeSql(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\\'/g, "'")
    // MySQL exposes string literals in CHECK_CLAUSE as _utf8mb4'...'.
    .replace(/_[a-z0-9]+(?=')/g, '')
    .replace(/[`\s()]/g, '');
}

function normalizeAction(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/_/g, ' ');
  return normalized === 'NO ACTION' ? 'RESTRICT' : normalized;
}

function definition(Sequelize) {
  const timestamps = {
    created_at: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
    updated_at: {
      type: Sequelize.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
    },
  };
  return {
    WebContentGenerations: {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      scope_type: { type: Sequelize.ENUM('clinic', 'group'), allowNull: false },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
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
      requested_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      content_type: {
        type: Sequelize.ENUM(
          'value_proposition',
          'benefit',
          'faq',
          'treatment_copy',
          'professional_bio',
          'testimonial',
          'legal_copy',
          'article',
          'category'
        ),
        allowNull: false,
      },
      locale: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'es-ES' },
      tone: {
        type: Sequelize.ENUM('professional_clear', 'close_reassuring', 'concise', 'informative'),
        allowNull: false,
      },
      objective: { type: Sequelize.STRING(64), allowNull: false },
      context_snapshot: { type: Sequelize.JSON, allowNull: false },
      input_hash: { type: Sequelize.STRING(64), allowNull: false },
      idempotency_key_hash: { type: Sequelize.STRING(64), allowNull: false },
      execution_attempt_token_hash: { type: Sequelize.STRING(64), allowNull: true },
      status: {
        type: Sequelize.ENUM('queued', 'running', 'completed', 'accepted', 'failed'),
        allowNull: false,
        defaultValue: 'queued',
      },
      proposal: { type: Sequelize.JSON, allowNull: true },
      proposal_hash: { type: Sequelize.STRING(64), allowNull: true },
      provenance: { type: Sequelize.JSON, allowNull: true },
      error_summary: { type: Sequelize.JSON, allowNull: true },
      job_request_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: 'JobRequests', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      accepted_content_entry_id: {
        type: Sequelize.STRING(36),
        allowNull: true,
        references: { model: 'WebContentEntries', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      accepted_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      started_at: { type: Sequelize.DATE, allowNull: true },
      completed_at: { type: Sequelize.DATE, allowNull: true },
      accepted_at: { type: Sequelize.DATE, allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      ...timestamps,
    },
    WebContentGenerationQuotaBuckets: {
      bucket_key_hash: { type: Sequelize.STRING(64), allowNull: false, primaryKey: true },
      bucket_type: { type: Sequelize.ENUM('global', 'user_scope'), allowNull: false },
      bucket_start: { type: Sequelize.DATE, allowNull: false },
      request_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      ...timestamps,
    },
  };
}

function assertCapabilities(queryInterface) {
  const required = [
    'showAllTables',
    'createTable',
    'describeTable',
    'addColumn',
    'showIndex',
    'addIndex',
    'addConstraint',
    'dropTable',
  ];
  const missing = required.filter((name) => typeof queryInterface?.[name] !== 'function');
  if (typeof queryInterface?.sequelize?.query !== 'function') missing.push('sequelize.query');
  if (missing.length) {
    throw migrationError(
      'web_content_generation_migration_introspection_unavailable',
      `No se puede validar de forma segura la migración: faltan ${missing.join(', ')}.`
    );
  }
}

function assertDependencies(inventory) {
  const missing = DEPENDENCIES.filter((name) => !inventoryTableName(inventory, name));
  if (missing.length) {
    throw migrationError(
      'web_content_generation_migration_missing_dependency',
      `No se puede crear el asistente de contenido; faltan ${missing.join(', ')}.`,
      { missing_tables: missing }
    );
  }
}

function typeString(column) {
  const type = column?.type;
  if (!type) return '';
  if (typeof type === 'string') return type.toUpperCase().replace(/\s+/g, ' ').trim();

  // QueryInterface mutates/binds DataType instances to the active dialect
  // while creating a table. Calling String() on a dialect-bound MySQL ENUM
  // outside the query generator then tries to use an absent escape callback.
  // Build the small descriptor needed by this migration from public DataType
  // metadata instead, so the post-DDL compatibility check also works against
  // a real MySQL server (not only the in-memory migration double).
  const key = String(type.key || type.constructor?.key || '').toUpperCase();
  if (key === 'ENUM') {
    const values = Array.isArray(type.values)
      ? type.values
      : (Array.isArray(type.options?.values) ? type.options.values : []);
    return `ENUM(${values.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(',')})`;
  }
  if (key === 'STRING') {
    const length = Number(type.options?.length || type._length || 255);
    return `VARCHAR(${length})`;
  }
  if (key === 'INTEGER') {
    return `INTEGER${type._unsigned === true || type.options?.unsigned === true ? ' UNSIGNED' : ''}`;
  }
  if (['JSON', 'DATE', 'TEXT'].includes(key)) return key;

  return String(type).toUpperCase().replace(/\s+/g, ' ').trim();
}

function expectedTypeKind(column) {
  const type = typeString(column);
  if (type.includes('UNSIGNED') && type.includes('INT')) return 'integer_unsigned';
  if (type.includes('INT')) return 'integer_signed';
  if (type.startsWith('VARCHAR') || type.startsWith('CHAR')) return 'string';
  if (type.startsWith('ENUM')) return 'enum';
  if (type.includes('JSON')) return 'json';
  if (type.includes('DATE') || type.includes('TIME')) return 'date';
  return type.toLowerCase();
}

function stringLength(type) {
  const match = String(type || '').match(/(?:VAR)?CHAR\((\d+)\)/i);
  return match ? Number(match[1]) : null;
}

function enumValues(column) {
  const declared = Array.isArray(column?.values)
    ? column.values
    : (Array.isArray(column?.type?.values)
      ? column.type.values
      : (Array.isArray(column?.type?.options?.values) ? column.type.options.values : null));
  if (declared) return declared.map((value) => String(value));
  const type = typeof column?.type === 'string'
    ? column.type.trim()
    : typeString(column);
  const match = type.match(/^ENUM\s*\((.*)\)$/i);
  if (!match) return null;
  const values = [];
  const source = match[1];
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    if (source[cursor] !== "'") return null;
    cursor += 1;
    let value = '';
    let closed = false;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "'" && source[cursor + 1] === "'") {
        value += "'";
        cursor += 2;
        continue;
      }
      if (char === '\\' && cursor + 1 < source.length) {
        value += source[cursor + 1];
        cursor += 2;
        continue;
      }
      if (char === "'") {
        cursor += 1;
        closed = true;
        break;
      }
      value += char;
      cursor += 1;
    }
    if (!closed) return null;
    values.push(value);
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    if (cursor === source.length) break;
    if (source[cursor] !== ',') return null;
    cursor += 1;
  }
  return values;
}

function assertColumnCompatible(tableName, name, actual, expected) {
  const actualType = typeString(actual);
  const expectedType = typeString(expected);
  const kind = expectedTypeKind(expected);
  let compatible = true;
  if (kind === 'integer_unsigned') {
    compatible = actualType.includes('INT') && actualType.includes('UNSIGNED') && !actualType.includes('BIGINT');
  } else if (kind === 'integer_signed') {
    compatible = actualType.includes('INT') && !actualType.includes('UNSIGNED') && !actualType.includes('BIGINT');
  } else if (kind === 'string') {
    compatible = /(?:VAR)?CHAR\(/.test(actualType)
      && stringLength(actualType) === stringLength(expectedType);
  } else if (kind === 'enum') {
    const expectedValues = enumValues(expected);
    const actualValues = enumValues(actual);
    compatible = actualType.startsWith('ENUM')
      && Array.isArray(expectedValues)
      && Array.isArray(actualValues)
      && expectedValues.length === actualValues.length
      && expectedValues.every((value, index) => value === actualValues[index]);
  } else if (kind === 'json') {
    compatible = actualType.includes('JSON') || actualType.includes('LONGTEXT');
  } else if (kind === 'date') {
    compatible = actualType.includes('DATE') || actualType.includes('TIME');
  }
  if (!compatible || Boolean(actual.allowNull) !== Boolean(expected.allowNull)) {
    throw migrationError(
      'web_content_generation_migration_incompatible_column',
      `${tableName}.${name} no coincide con el contrato esperado.`,
      { table: tableName, column: name, actual_type: actualType, expected_type: expectedType }
    );
  }
  if (expected.primaryKey === true && actual.primaryKey !== true) {
    throw migrationError(
      'web_content_generation_migration_incompatible_primary_key',
      `${tableName}.${name} debe ser la clave primaria.`
    );
  }
}

async function ensureColumns(queryInterface, tableName, columns) {
  let actual = await queryInterface.describeTable(tableName);
  // Validate every existing column before applying repair DDL.
  for (const [name, expected] of Object.entries(columns)) {
    if (actual[name]) assertColumnCompatible(tableName, name, actual[name], expected);
  }
  for (const [name, expected] of Object.entries(columns)) {
    if (!actual[name]) await queryInterface.addColumn(tableName, name, expected);
  }
  actual = await queryInterface.describeTable(tableName);
  for (const [name, expected] of Object.entries(columns)) {
    if (!actual[name]) {
      throw migrationError(
        'web_content_generation_migration_incomplete_table',
        `${tableName} sigue incompleta: falta ${name}.`
      );
    }
    assertColumnCompatible(tableName, name, actual[name], expected);
  }
}

function foreignKeyContracts(columns) {
  return Object.entries(columns).flatMap(([column, definitionValue]) => {
    const reference = definitionValue.references;
    if (!reference) return [];
    const table = tableNameOf(reference.model);
    return [{
      column,
      table,
      referencedColumn: reference.key,
      onUpdate: normalizeAction(definitionValue.onUpdate || 'CASCADE'),
      onDelete: normalizeAction(definitionValue.onDelete || 'RESTRICT'),
      name: `fk_web_content_generations_${column}`,
    }];
  });
}

async function loadForeignKeys(queryInterface, tableName) {
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
        AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
    { replacements: { tableName } }
  );
  const rows = rowsFromQueryResult(result);
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    name: String(row.constraint_name || row.constraintName || ''),
    column: String(row.column_name || row.columnName || '').toLowerCase(),
    table: String(row.referenced_table_name || row.referencedTableName || '').toLowerCase(),
    referencedColumn: String(row.referenced_column_name || row.referencedColumnName || '').toLowerCase(),
    onUpdate: normalizeAction(row.update_rule || row.updateRule),
    onDelete: normalizeAction(row.delete_rule || row.deleteRule),
  }));
}

function matchingForeignKey(reference, contract) {
  return reference.table === contract.table.toLowerCase()
    && reference.referencedColumn === contract.referencedColumn.toLowerCase()
    && reference.onUpdate === contract.onUpdate
    && reference.onDelete === contract.onDelete;
}

async function ensureForeignKeys(queryInterface, tableName, contracts) {
  let current = await loadForeignKeys(queryInterface, tableName);
  for (const contract of contracts) {
    const matches = current.filter((item) => item.column === contract.column.toLowerCase());
    if (matches.length > 1 || (matches.length === 1 && !matchingForeignKey(matches[0], contract))) {
      throw migrationError(
        'web_content_generation_migration_incompatible_foreign_key',
        `${tableName}.${contract.column} tiene una clave foránea incompatible.`,
        { actual: matches, expected: contract }
      );
    }
    if (!matches.length) {
      await queryInterface.addConstraint(tableName, {
        fields: [contract.column],
        type: 'foreign key',
        name: contract.name,
        references: { table: contract.table, field: contract.referencedColumn },
        onUpdate: contract.onUpdate,
        onDelete: contract.onDelete,
      });
      current = await loadForeignKeys(queryInterface, tableName);
      const verified = current.filter((item) => item.column === contract.column.toLowerCase());
      if (verified.length !== 1 || !matchingForeignKey(verified[0], contract)) {
        throw migrationError(
          'web_content_generation_migration_foreign_key_repair_failed',
          `No se ha podido completar ${tableName}.${contract.column}.`
        );
      }
    }
  }
}

async function loadConstraints(queryInterface, tableName) {
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

async function ensureScopeCheck(queryInterface, Sequelize, tableName) {
  if (String(tableName).toLowerCase() !== 'webcontentgenerations') return;
  const name = 'chk_web_content_generations_scope';
  const current = await loadConstraints(queryInterface, tableName);
  const named = current.filter((item) => (
    String(item.constraint_name || item.constraintName || '').toLowerCase() === name
  ));
  if (named.length > 1) {
    throw migrationError(
      'web_content_generation_migration_incompatible_check',
      `${tableName}.${name} aparece más de una vez.`
    );
  }
  if (named.length === 1) {
    const item = named[0];
    const type = String(item.constraint_type || item.constraintType || '').toUpperCase();
    const clause = item.check_clause ?? item.checkClause ?? null;
    if (type !== 'CHECK' || !clause || normalizeSql(clause) !== normalizeSql(SCOPE_CHECK)) {
      throw migrationError(
        'web_content_generation_migration_incompatible_check',
        `${tableName}.${name} no coincide con el contrato de scope.`,
        { type, clause }
      );
    }
    return;
  }
  const aliases = current.filter((item) => {
    if (String(item.constraint_type || item.constraintType || '').toUpperCase() !== 'CHECK') return false;
    const clause = normalizeSql(item.check_clause ?? item.checkClause);
    return clause.includes('scope_type') || clause.includes('clinica_id') || clause.includes('grupo_clinica_id');
  });
  if (aliases.length) {
    throw migrationError(
      'web_content_generation_migration_incompatible_check',
      `${tableName} ya contiene otro CHECK de scope.`
    );
  }
  const violationResult = await queryInterface.sequelize.query(
    `SELECT COUNT(*) AS violation_count FROM \`${tableName}\` WHERE NOT (${SCOPE_CHECK})`
  );
  const violationRows = rowsFromQueryResult(violationResult);
  if (Number(violationRows?.[0]?.violation_count || 0) > 0) {
    throw migrationError(
      'web_content_generation_migration_scope_violation',
      `${tableName} contiene filas que incumplen el scope.`
    );
  }
  await queryInterface.addConstraint(tableName, {
    fields: ['scope_type', 'clinica_id', 'grupo_clinica_id'],
    type: 'check',
    name,
    where: Sequelize.literal(SCOPE_CHECK),
  });
  const verified = await loadConstraints(queryInterface, tableName);
  const check = verified.find((item) => (
    String(item.constraint_name || item.constraintName || '').toLowerCase() === name
  ));
  const clause = check?.check_clause ?? check?.checkClause ?? null;
  if (!check || !clause || normalizeSql(clause) !== normalizeSql(SCOPE_CHECK)) {
    throw migrationError(
      'web_content_generation_migration_check_repair_failed',
      `No se ha podido completar ${tableName}.${name}.`
    );
  }
}

function indexFields(index) {
  return (index?.fields || []).map((field) => (
    String(field.attribute || field.name || field.column || '').toLowerCase()
  ));
}

async function ensureIndex(queryInterface, tableName, contract) {
  let indexes = await queryInterface.showIndex(tableName);
  if (!Array.isArray(indexes)) indexes = [];
  const named = indexes.find((index) => String(index.name || '').toLowerCase() === contract.name.toLowerCase());
  if (named) {
    if (
      indexFields(named).join(',') !== contract.fields.join(',').toLowerCase()
      || Boolean(named.unique) !== Boolean(contract.unique)
    ) {
      throw migrationError(
        'web_content_generation_migration_incompatible_index',
        `${tableName}.${contract.name} existe con otro contrato.`
      );
    }
    return;
  }
  const equivalent = indexes.find((index) => (
    indexFields(index).join(',') === contract.fields.join(',').toLowerCase()
    && Boolean(index.unique) === Boolean(contract.unique)
  ));
  if (equivalent) return;
  await queryInterface.addIndex(tableName, contract.fields, {
    name: contract.name,
    ...(contract.unique ? { unique: true } : {}),
  });
  indexes = await queryInterface.showIndex(tableName);
  const verified = indexes.find((index) => String(index.name || '').toLowerCase() === contract.name.toLowerCase());
  if (!verified || indexFields(verified).join(',') !== contract.fields.join(',').toLowerCase()) {
    throw migrationError(
      'web_content_generation_migration_index_repair_failed',
      `No se ha podido completar ${tableName}.${contract.name}.`
    );
  }
}

async function ensureTable(queryInterface, Sequelize, tableName, columns, inventory) {
  let actualName = inventoryTableName(inventory, tableName);
  if (!actualName) {
    await queryInterface.createTable(tableName, columns);
    actualName = tableName;
  }
  await ensureColumns(queryInterface, actualName, columns);
  await ensureForeignKeys(queryInterface, actualName, foreignKeyContracts(columns));
  await ensureScopeCheck(queryInterface, Sequelize, actualName);
  for (const contract of INDEX_CONTRACTS[tableName]) {
    await ensureIndex(queryInterface, actualName, contract);
  }
}

module.exports = {
  TABLES,
  DEPENDENCIES,

  async up(queryInterface, Sequelize) {
    assertCapabilities(queryInterface);
    const inventory = await tableInventory(queryInterface);
    assertDependencies(inventory);
    const definitions = definition(Sequelize);
    for (const tableName of TABLES) {
      await ensureTable(queryInterface, Sequelize, tableName, definitions[tableName], inventory);
    }
  },

  async down(queryInterface) {
    if (typeof queryInterface?.showAllTables !== 'function' || typeof queryInterface?.dropTable !== 'function') {
      throw migrationError(
        'web_content_generation_migration_introspection_unavailable',
        'No se puede revertir de forma segura la migración.'
      );
    }
    for (const tableName of [...TABLES].reverse()) {
      const actualName = inventoryTableName(await tableInventory(queryInterface), tableName);
      if (actualName) await queryInterface.dropTable(actualName);
    }
  },

  __testing: {
    assertColumnCompatible,
    definition,
    normalizeAction,
    normalizeSql,
  },
};
