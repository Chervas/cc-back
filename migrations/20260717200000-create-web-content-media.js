'use strict';

const TABLES = Object.freeze([
  'WebMediaAssets',
  'WebContentEntries',
  'WebContentEntryVersions',
]);

const DEPENDENCIES = Object.freeze([
  'Clinicas',
  'GruposClinicas',
  'Usuarios',
  'PublicMediaAssets',
]);

const SCOPE_CHECK_CLAUSE = "((scope_type = 'clinic' AND clinica_id IS NOT NULL AND grupo_clinica_id IS NULL) "
  + "OR (scope_type = 'group' AND clinica_id IS NULL AND grupo_clinica_id IS NOT NULL))";

const INDEX_CONTRACTS = Object.freeze({
  WebMediaAssets: Object.freeze([
    { name: 'uniq_web_media_public_asset', fields: ['public_media_asset_id'], unique: true },
    { name: 'idx_web_media_clinic_status', fields: ['clinica_id', 'status', 'created_at'], unique: false },
    { name: 'idx_web_media_group_status', fields: ['grupo_clinica_id', 'status', 'created_at'], unique: false },
    { name: 'idx_web_media_kind_status', fields: ['kind', 'status'], unique: false },
  ]),
  WebContentEntries: Object.freeze([
    { name: 'idx_web_content_clinic_status', fields: ['clinica_id', 'status', 'updated_at'], unique: false },
    { name: 'idx_web_content_group_status', fields: ['grupo_clinica_id', 'status', 'updated_at'], unique: false },
    { name: 'idx_web_content_type_locale_status', fields: ['type', 'locale', 'status'], unique: false },
    { name: 'idx_web_content_owner_status', fields: ['owner_user_id', 'status'], unique: false },
    { name: 'idx_web_content_hash', fields: ['content_hash'], unique: false },
  ]),
  WebContentEntryVersions: Object.freeze([
    { name: 'uniq_web_content_entry_version', fields: ['content_entry_id', 'version'], unique: true },
    { name: 'idx_web_content_versions_entry', fields: ['content_entry_id', 'created_at'], unique: false },
    { name: 'idx_web_content_versions_hash', fields: ['content_hash'], unique: false },
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
  const tables = await queryInterface.showAllTables();
  const byLowerName = new Map();
  for (const value of tables) {
    const name = tableNameOf(value);
    if (!name) continue;
    const key = name.toLowerCase();
    const matches = byLowerName.get(key) || [];
    matches.push(name);
    byLowerName.set(key, matches);
  }
  return byLowerName;
}

function inventoryTableName(inventory, expectedName) {
  const matches = inventory.get(expectedName.toLowerCase()) || [];
  if (matches.length > 1) {
    throw migrationError(
      'web_content_media_migration_ambiguous_table',
      `Hay varias tablas que podrían corresponder a ${expectedName}: ${matches.join(', ')}.`,
      { table: expectedName, matches }
    );
  }
  return matches[0] || null;
}

function assertQueryInterfaceCapabilities(queryInterface) {
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
      'web_content_media_migration_introspection_unavailable',
      `No se puede validar de forma segura el DDL de contenido web: faltan ${missing.join(', ')}.`,
      { missing_methods: missing }
    );
  }
}

function assertDependencies(inventory) {
  const missing = DEPENDENCIES.filter((name) => !inventoryTableName(inventory, name));
  if (missing.length) {
    throw migrationError(
      'web_content_media_migration_missing_dependency',
      `No se puede crear contenido/media web; faltan tablas previas: ${missing.join(', ')}.`,
      { missing_tables: missing }
    );
  }
}

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

const clinicScopeColumns = (Sequelize) => ({
  scope_type: { type: Sequelize.ENUM('clinic', 'group'), allowNull: false },
  clinica_id: {
    type: Sequelize.INTEGER,
    allowNull: true,
    references: { model: 'Clinicas', key: 'id_clinica' },
    // MySQL 8 rejects CHECK constraints whose columns can be changed through
    // an ON UPDATE CASCADE foreign key (error 3823). Clinic identifiers are
    // stable identities, so updates must be refused rather than propagated.
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

const userForeignKey = (Sequelize) => ({
  type: Sequelize.INTEGER,
  allowNull: true,
  references: { model: 'Usuarios', key: 'id_usuario' },
  onUpdate: 'CASCADE',
  onDelete: 'SET NULL',
});

function tableDefinitions(Sequelize) {
  const contentTypes = [
    'value_proposition',
    'benefit',
    'faq',
    'treatment_copy',
    'professional_bio',
    'testimonial',
    'legal_copy',
    'article',
    'category',
  ];
  return {
    WebMediaAssets: {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      ...clinicScopeColumns(Sequelize),
      public_media_asset_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'PublicMediaAssets', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      owner_user_id: userForeignKey(Sequelize),
      title: { type: Sequelize.STRING(191), allowNull: false },
      kind: { type: Sequelize.ENUM('image'), allowNull: false },
      status: {
        type: Sequelize.ENUM('processing', 'ready', 'failed', 'archived'),
        allowNull: false,
        defaultValue: 'ready',
      },
      alt_text: { type: Sequelize.STRING(500), allowNull: false, defaultValue: '' },
      decorative: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      focal_points: { type: Sequelize.JSON, allowNull: false },
      rights: { type: Sequelize.JSON, allowNull: false },
      variants: { type: Sequelize.JSON, allowNull: false },
      media_metadata: { type: Sequelize.JSON, allowNull: false },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      created_by_user_id: userForeignKey(Sequelize),
      updated_by_user_id: userForeignKey(Sequelize),
      ...timestamps(Sequelize),
    },
    WebContentEntries: {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      ...clinicScopeColumns(Sequelize),
      owner_user_id: userForeignKey(Sequelize),
      type: { type: Sequelize.ENUM(...contentTypes), allowNull: false },
      locale: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'es-ES' },
      title: { type: Sequelize.STRING(191), allowNull: false },
      content: { type: Sequelize.JSON, allowNull: false },
      sources: { type: Sequelize.JSON, allowNull: false },
      content_hash: { type: Sequelize.STRING(64), allowNull: false },
      status: {
        type: Sequelize.ENUM('draft', 'review', 'published', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      created_by_user_id: userForeignKey(Sequelize),
      updated_by_user_id: userForeignKey(Sequelize),
      ...timestamps(Sequelize, { deleted: true }),
    },
    WebContentEntryVersions: {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      content_entry_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        references: { model: 'WebContentEntries', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      type: { type: Sequelize.ENUM(...contentTypes), allowNull: false },
      locale: { type: Sequelize.STRING(16), allowNull: false },
      title: { type: Sequelize.STRING(191), allowNull: false },
      content: { type: Sequelize.JSON, allowNull: false },
      sources: { type: Sequelize.JSON, allowNull: false },
      content_hash: { type: Sequelize.STRING(64), allowNull: false },
      status: {
        type: Sequelize.ENUM('draft', 'review', 'published', 'archived'),
        allowNull: false,
      },
      actor_user_id: userForeignKey(Sequelize),
      ...timestamps(Sequelize, { updated: false }),
    },
  };
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
    // Dialect-specific Sequelize ENUM instances require an internal escape
    // function in toSql(). The key is sufficient for contract comparisons;
    // enumValues() validates the exact values separately.
    return typeKey(type);
  }
}

function enumValues(type) {
  const direct = type?.values || type?.options?.values;
  if (Array.isArray(direct)) return direct.map(String);
  const text = String(type || '').trim();
  if (!/^ENUM\(/i.test(text)) return null;
  const values = [];
  const pattern = /'((?:''|\\'|[^'])*)'/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    values.push(match[1].replace(/''/g, "'").replace(/\\'/g, "'"));
  }
  return values.length ? values : null;
}

function typeMatches(actual, expected) {
  const actualText = typeText(actual);
  const expectedText = typeText(expected);
  const expectedKey = typeKey(expected);
  if (expectedKey === 'STRING') {
    const length = Number(expected?._length || expected?.options?.length || 0);
    return length
      ? new RegExp(`^(?:VAR)?CHAR\\(${length}\\)`).test(actualText)
      : /^(?:VAR)?CHAR(?:\(|$)/.test(actualText);
  }
  if (expectedKey === 'INTEGER') {
    return /^(?:INT|INTEGER)(?:\(\d+\))?(?: UNSIGNED)?$/.test(actualText);
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
      'web_content_media_migration_incompatible_table',
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
      const expectedValues = enumValues(contract.type);
      const actualValues = enumValues(metadata?.type);
      if (!expectedValues || !actualValues || expectedValues.join(',') !== actualValues.join(',')) {
        mismatches.push(`${column}:enum=${actualValues?.join('|') || 'unknown'}`);
      }
    }
    if (
      Object.hasOwn(contract, 'defaultValue')
      && normalizedDefault(metadata?.defaultValue) !== normalizedDefault(contract.defaultValue)
    ) {
      mismatches.push(`${column}:default=${String(metadata?.defaultValue)}`);
    }
  }
  if (mismatches.length) {
    throw migrationError(
      'web_content_media_migration_incompatible_column',
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

function inspectIndexes(tableName, indexes, contracts) {
  const missing = [];
  for (const contract of contracts) {
    const named = indexes.filter((index) => String(index?.name || '') === contract.name);
    if (named.length > 1) {
      throw migrationError(
        'web_content_media_migration_incompatible_index',
        `${tableName}.${contract.name} aparece más de una vez.`,
        { table: tableName, index: contract.name, reason: 'duplicate_name' }
      );
    }
    if (named.length === 1) {
      const actualFields = fieldsOf(named[0]);
      if (
        actualFields.join(',') !== contract.fields.join(',')
        || Boolean(named[0].unique) !== contract.unique
      ) {
        throw migrationError(
          'web_content_media_migration_incompatible_index',
          `${tableName}.${contract.name} no coincide con el contrato.`,
          {
            table: tableName,
            index: contract.name,
            actual_fields: actualFields,
            expected_fields: contract.fields,
          }
        );
      }
      continue;
    }
    const aliases = indexes.filter((index) => (
      fieldsOf(index).join(',') === contract.fields.join(',')
      && Boolean(index.unique) === contract.unique
      && String(index?.name || '').toUpperCase() !== 'PRIMARY'
    ));
    if (aliases.length) {
      throw migrationError(
        'web_content_media_migration_incompatible_index',
        `${tableName} tiene un índice equivalente con otro nombre: ${aliases.map((item) => item.name).join(', ')}.`,
        { table: tableName, index: contract.name, aliases: aliases.map((item) => item.name) }
      );
    }
    missing.push(contract);
  }
  return missing;
}

function rowsFromQueryResult(result) {
  return Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
}

async function queryForeignKeyActions(queryInterface, tableName) {
  if (!queryInterface.sequelize || typeof queryInterface.sequelize.query !== 'function') return [];
  const result = await queryInterface.sequelize.query(
    'SELECT kcu.CONSTRAINT_NAME AS constraintName, kcu.COLUMN_NAME AS columnName, '
      + 'kcu.REFERENCED_TABLE_NAME AS referencedTableName, '
      + 'kcu.REFERENCED_COLUMN_NAME AS referencedColumnName, '
      + 'rc.UPDATE_RULE AS updateRule, rc.DELETE_RULE AS deleteRule '
      + 'FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu '
      + 'JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc '
      + 'ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA '
      + 'AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME '
      + 'AND rc.TABLE_NAME = kcu.TABLE_NAME '
      + 'WHERE kcu.CONSTRAINT_SCHEMA = DATABASE() '
      + 'AND kcu.TABLE_NAME = :tableName AND kcu.REFERENCED_TABLE_NAME IS NOT NULL',
    { replacements: { tableName } }
  );
  const rows = rowsFromQueryResult(result);
  return Array.isArray(rows) ? rows : [];
}

function actionOf(reference, kind) {
  const candidates = kind === 'update'
    ? ['onUpdate', 'updateRule', 'update_rule', 'UPDATE_RULE']
    : ['onDelete', 'deleteRule', 'delete_rule', 'DELETE_RULE'];
  const value = candidates.map((key) => reference?.[key]).find((item) => item != null);
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

async function loadForeignKeys(queryInterface, tableName) {
  let references = await queryInterface.getForeignKeyReferencesForTable(tableName);
  if (!Array.isArray(references)) references = [];
  if (references.some((reference) => !actionOf(reference, 'update') || !actionOf(reference, 'delete'))) {
    const enriched = await queryForeignKeyActions(queryInterface, tableName);
    if (enriched.length) references = enriched;
  }
  return references.map(normalizeForeignKey);
}

function expectedForeignKeys(tableName, definition) {
  return Object.entries(definition).flatMap(([column, contract]) => {
    if (!contract.references) return [];
    return [{
      name: `fk_${tableName.toLowerCase()}_${column}`,
      column,
      table: tableNameOf(contract.references.model),
      referencedColumn: contract.references.key,
      onUpdate: String(contract.onUpdate || 'NO ACTION').toUpperCase(),
      onDelete: String(contract.onDelete || 'NO ACTION').toUpperCase(),
      repairableOnUpdateFrom: ['clinica_id', 'grupo_clinica_id'].includes(column)
        && ['webmediaassets', 'webcontententries'].includes(tableName.toLowerCase())
        ? ['CASCADE']
        : [],
    }];
  });
}

function compatibleAction(actual, expected) {
  if (actual === expected) return true;
  return ['RESTRICT', 'NO ACTION'].includes(actual)
    && ['RESTRICT', 'NO ACTION'].includes(expected);
}

function inspectForeignKeys(tableName, actual, expected) {
  const missing = [];
  const replacements = [];
  for (const contract of expected) {
    const matches = actual.filter((reference) => reference.column === contract.column.toLowerCase());
    if (matches.length > 1) {
      throw migrationError(
        'web_content_media_migration_incompatible_foreign_key',
        `${tableName}.${contract.column} tiene varias claves foráneas.`,
        { table: tableName, column: contract.column, reason: 'ambiguous' }
      );
    }
    if (matches.length === 0) {
      missing.push(contract);
      continue;
    }
    const reference = matches[0];
    const expectedUpdate = contract.onUpdate.replace(/_/g, ' ');
    const expectedDelete = contract.onDelete.replace(/_/g, ' ');
    const targetMatches = reference.table === contract.table.toLowerCase()
      && reference.referencedColumn === contract.referencedColumn.toLowerCase();
    const deleteMatches = reference.onDelete
      && compatibleAction(reference.onDelete, expectedDelete);
    const updateMatches = reference.onUpdate
      && compatibleAction(reference.onUpdate, expectedUpdate);
    if (targetMatches && deleteMatches && updateMatches) continue;
    if (
      targetMatches
      && deleteMatches
      && reference.name
      && contract.repairableOnUpdateFrom.includes(reference.onUpdate)
    ) {
      replacements.push({ contract, current: reference });
      continue;
    }
    throw migrationError(
      'web_content_media_migration_incompatible_foreign_key',
      `${tableName}.${contract.column} tiene una clave foránea incompatible.`,
      { table: tableName, column: contract.column, actual: reference, expected: contract }
    );
  }
  return { missing, replacements };
}

function replacementForeignKeyName(contract, current) {
  return current.name.toLowerCase() === contract.name.toLowerCase()
    ? `${contract.name}_restrict`
    : contract.name;
}

function constraintNameOf(value) {
  return String(value?.constraintName || value?.constraint_name || value?.name || '');
}

function constraintTypeOf(value) {
  return String(value?.constraintType || value?.constraint_type || value?.type || '')
    .trim()
    .toUpperCase();
}

function checkClauseOf(value) {
  const clause = value?.checkClause ?? value?.check_clause ?? value?.definition ?? value?.where ?? null;
  if (clause && typeof clause === 'object' && Object.hasOwn(clause, 'val')) return String(clause.val);
  return clause == null ? null : String(clause);
}

async function queryDatabaseConstraints(queryInterface, tableName) {
  if (!queryInterface.sequelize || typeof queryInterface.sequelize.query !== 'function') return null;
  const result = await queryInterface.sequelize.query(
    'SELECT tc.CONSTRAINT_NAME AS constraintName, tc.CONSTRAINT_TYPE AS constraintType, '
      + 'cc.CHECK_CLAUSE AS checkClause '
      + 'FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc '
      + 'LEFT JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc '
      + 'ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA '
      + 'AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME '
      + 'WHERE tc.TABLE_SCHEMA = DATABASE() AND tc.TABLE_NAME = :tableName '
      + 'ORDER BY tc.CONSTRAINT_NAME',
    { replacements: { tableName } }
  );
  const rows = rowsFromQueryResult(result);
  return Array.isArray(rows) ? rows : [];
}

async function loadConstraints(queryInterface, tableName) {
  const databaseConstraints = await queryDatabaseConstraints(queryInterface, tableName);
  if (databaseConstraints !== null) return databaseConstraints;
  let constraints = await queryInterface.showConstraint(tableName);
  if (!Array.isArray(constraints)) constraints = [];
  return constraints;
}

function normalizeCheckClause(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\\'/g, "'")
    .replace(/_[a-z0-9]+(?=')/g, '')
    .replace(/[`\s()]/g, '');
}

function inspectScopeConstraint(tableName, constraints) {
  const name = `chk_${tableName.toLowerCase()}_scope`;
  const named = constraints.filter((item) => constraintNameOf(item).toLowerCase() === name.toLowerCase());
  if (named.length > 1) {
    throw migrationError(
      'web_content_media_migration_incompatible_constraint',
      `${tableName}.${name} aparece más de una vez.`,
      { table: tableName, constraint: name, reason: 'duplicate_name' }
    );
  }
  if (named.length === 1) {
    const type = constraintTypeOf(named[0]);
    const clause = checkClauseOf(named[0]);
    if (type !== 'CHECK' || !clause || normalizeCheckClause(clause) !== normalizeCheckClause(SCOPE_CHECK_CLAUSE)) {
      throw migrationError(
        'web_content_media_migration_incompatible_constraint',
        `${tableName}.${name} no coincide con el contrato de scope.`,
        { table: tableName, constraint: name, type, clause }
      );
    }
    return null;
  }
  const scopeChecks = constraints.filter((item) => {
    if (constraintTypeOf(item) !== 'CHECK') return false;
    const normalized = normalizeCheckClause(checkClauseOf(item));
    return normalized.includes('scope_type')
      || normalized.includes('clinica_id')
      || normalized.includes('grupo_clinica_id');
  });
  if (scopeChecks.length) {
    throw migrationError(
      'web_content_media_migration_incompatible_constraint',
      `${tableName} tiene otro CHECK de scope y no se puede completar de forma inequívoca.`,
      { table: tableName, constraint: name, aliases: scopeChecks.map(constraintNameOf) }
    );
  }
  return { name, clause: SCOPE_CHECK_CLAUSE };
}

async function inspectTable(queryInterface, tableName, definition) {
  const actual = await queryInterface.describeTable(tableName);
  assertColumns(tableName, actual, definition);
  const [foreignKeys, constraints, indexes] = await Promise.all([
    loadForeignKeys(queryInterface, tableName),
    loadConstraints(queryInterface, tableName),
    queryInterface.showIndex(tableName),
  ]);
  const expectedFks = expectedForeignKeys(tableName, definition);
  const foreignKeyPlan = inspectForeignKeys(tableName, foreignKeys, expectedFks);
  const plannedForeignKeys = [
    ...foreignKeyPlan.missing.map((contract) => ({ contract, current: null, targetName: contract.name })),
    ...foreignKeyPlan.replacements.map(({ contract, current }) => ({
      contract,
      current,
      targetName: replacementForeignKeyName(contract, current),
    })),
  ];
  for (const { contract, current, targetName } of plannedForeignKeys) {
    const conflict = constraints.find((item) => (
      constraintNameOf(item).toLowerCase() === targetName.toLowerCase()
    ));
    const conflictIsReplacedForeignKey = conflict
      && current
      && current.name.toLowerCase() === targetName.toLowerCase()
      && constraintTypeOf(conflict) === 'FOREIGN KEY';
    if (conflict && !conflictIsReplacedForeignKey) {
      throw migrationError(
        'web_content_media_migration_incompatible_constraint',
        `${tableName}.${targetName} existe pero no describe la FK esperada.`,
        { table: tableName, constraint: targetName }
      );
    }
  }
  if (
    foreignKeyPlan.replacements.length
    && !canReplaceForeignKeyAtomically(queryInterface)
    && typeof queryInterface.removeConstraint !== 'function'
  ) {
    throw migrationError(
      'web_content_media_migration_foreign_key_repair_unavailable',
      `${tableName} requiere sustituir claves foráneas antiguas, pero el adaptador no permite hacerlo con seguridad.`,
      {
        table: tableName,
        columns: foreignKeyPlan.replacements.map(({ contract }) => contract.column),
        required_capability: 'sequelize.query(mysql) or removeConstraint',
      }
    );
  }
  return {
    tableName,
    missingForeignKeys: foreignKeyPlan.missing,
    replacementForeignKeys: foreignKeyPlan.replacements,
    missingScopeConstraint: tableName.toLowerCase() === 'webcontententryversions'
      ? null
      : inspectScopeConstraint(tableName, constraints),
    missingIndexes: inspectIndexes(tableName, Array.isArray(indexes) ? indexes : [], INDEX_CONTRACTS[tableName]),
  };
}

function dialectOf(queryInterface) {
  const sequelize = queryInterface?.sequelize;
  const dialect = typeof sequelize?.getDialect === 'function'
    ? sequelize.getDialect()
    : sequelize?.options?.dialect;
  return String(dialect || '').trim().toLowerCase();
}

function canReplaceForeignKeyAtomically(queryInterface) {
  return dialectOf(queryInterface) === 'mysql'
    && typeof queryInterface?.sequelize?.query === 'function';
}

function quoteMysqlIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function foreignKeyActionSql(value) {
  const action = String(value || '').trim().toUpperCase().replace(/_/g, ' ');
  if (!['CASCADE', 'RESTRICT', 'NO ACTION', 'SET NULL'].includes(action)) {
    throw migrationError(
      'web_content_media_migration_incompatible_foreign_key',
      `La acción de clave foránea ${action || '(vacía)'} no está permitida por esta migración.`,
      { action }
    );
  }
  return action;
}

async function addForeignKey(queryInterface, tableName, contract) {
  await queryInterface.addConstraint(tableName, {
    fields: [contract.column],
    type: 'foreign key',
    name: contract.name,
    references: { table: contract.table, field: contract.referencedColumn },
    onUpdate: contract.onUpdate,
    onDelete: contract.onDelete,
  });
}

async function replaceForeignKey(queryInterface, tableName, replacement) {
  const { contract, current } = replacement;
  const targetName = replacementForeignKeyName(contract, current);
  try {
    if (canReplaceForeignKeyAtomically(queryInterface)) {
      const sql = [
        `ALTER TABLE ${quoteMysqlIdentifier(tableName)}`,
        `DROP FOREIGN KEY ${quoteMysqlIdentifier(current.name)},`,
        `ADD CONSTRAINT ${quoteMysqlIdentifier(targetName)}`,
        `FOREIGN KEY (${quoteMysqlIdentifier(contract.column)})`,
        `REFERENCES ${quoteMysqlIdentifier(contract.table)} (${quoteMysqlIdentifier(contract.referencedColumn)})`,
        `ON UPDATE ${foreignKeyActionSql(contract.onUpdate)}`,
        `ON DELETE ${foreignKeyActionSql(contract.onDelete)}`,
      ].join(' ');
      await queryInterface.sequelize.query(sql);
    } else {
      if (typeof queryInterface.removeConstraint !== 'function') {
        throw migrationError(
          'web_content_media_migration_foreign_key_repair_unavailable',
          `${tableName}.${contract.column} no se puede sustituir con el adaptador actual.`,
          { table: tableName, column: contract.column, constraint: current.name }
        );
      }
      await queryInterface.removeConstraint(tableName, current.name);
      await addForeignKey(queryInterface, tableName, { ...contract, name: targetName });
    }
  } catch (cause) {
    if (cause?.code === 'web_content_media_migration_foreign_key_repair_unavailable') throw cause;
    const error = migrationError(
      'web_content_media_migration_foreign_key_repair_failed',
      `No se pudo sustituir de forma segura la clave foránea antigua ${tableName}.${contract.column}.`,
      {
        table: tableName,
        column: contract.column,
        previous_constraint: current.name,
        replacement_constraint: targetName,
        previous_on_update: current.onUpdate,
        required_on_update: contract.onUpdate,
      }
    );
    error.cause = cause;
    throw error;
  }
}

async function ensureForeignKey(queryInterface, tableName, contract) {
  const current = await loadForeignKeys(queryInterface, tableName);
  const plan = inspectForeignKeys(tableName, current, [contract]);
  if (plan.replacements.length) {
    await replaceForeignKey(queryInterface, tableName, plan.replacements[0]);
  } else if (plan.missing.length) {
    await addForeignKey(queryInterface, tableName, contract);
  } else {
    return;
  }

  const verified = inspectForeignKeys(
    tableName,
    await loadForeignKeys(queryInterface, tableName),
    [contract]
  );
  if (verified.missing.length || verified.replacements.length) {
    throw migrationError(
      'web_content_media_migration_foreign_key_repair_failed',
      `La clave foránea ${tableName}.${contract.column} no coincide después de repararla.`,
      { table: tableName, column: contract.column }
    );
  }
}

async function ensureScopeConstraint(queryInterface, Sequelize, tableName, contract) {
  if (!contract) return;
  const current = await loadConstraints(queryInterface, tableName);
  if (!inspectScopeConstraint(tableName, current)) return;
  await queryInterface.addConstraint(tableName, {
    fields: ['scope_type', 'clinica_id', 'grupo_clinica_id'],
    type: 'check',
    name: contract.name,
    where: Sequelize.literal(contract.clause),
  });
}

async function ensureIndex(queryInterface, tableName, contract) {
  const current = await queryInterface.showIndex(tableName);
  const missing = inspectIndexes(tableName, Array.isArray(current) ? current : [], [contract]);
  if (!missing.length) return;
  await queryInterface.addIndex(tableName, contract.fields, {
    name: contract.name,
    ...(contract.unique ? { unique: true } : {}),
  });
}

async function applyPlan(queryInterface, Sequelize, plan) {
  for (const { contract } of plan.replacementForeignKeys) {
    await ensureForeignKey(queryInterface, plan.tableName, contract);
  }
  for (const foreignKey of plan.missingForeignKeys) {
    await ensureForeignKey(queryInterface, plan.tableName, foreignKey);
  }
  await ensureScopeConstraint(queryInterface, Sequelize, plan.tableName, plan.missingScopeConstraint);
  for (const index of plan.missingIndexes) {
    await ensureIndex(queryInterface, plan.tableName, index);
  }
}

module.exports = {
  TABLES,
  DEPENDENCIES,

  async up(queryInterface, Sequelize) {
    if (typeof queryInterface?.showAllTables !== 'function') {
      throw migrationError(
        'web_content_media_migration_introspection_unavailable',
        'No se puede comprobar el inventario de tablas antes de migrar contenido/media web.'
      );
    }
    const initialInventory = await tableInventory(queryInterface);
    assertDependencies(initialInventory);
    assertQueryInterfaceCapabilities(queryInterface);
    const definitions = tableDefinitions(Sequelize);
    const existingPlans = new Map();

    // Validate every pre-existing managed table before mutating anything. A
    // later incompatible table must not leave earlier indexes half-repaired.
    for (const tableName of TABLES) {
      const existingName = inventoryTableName(initialInventory, tableName);
      if (existingName) {
        existingPlans.set(tableName, await inspectTable(queryInterface, existingName, definitions[tableName]));
      }
    }

    for (const tableName of TABLES) {
      let plan = existingPlans.get(tableName);
      if (!plan) {
        await queryInterface.createTable(tableName, definitions[tableName]);
        plan = await inspectTable(queryInterface, tableName, definitions[tableName]);
      }
      await applyPlan(queryInterface, Sequelize, plan);
    }
  },

  async down(queryInterface) {
    if (typeof queryInterface?.showAllTables !== 'function' || typeof queryInterface?.dropTable !== 'function') {
      throw migrationError(
        'web_content_media_migration_introspection_unavailable',
        'No se puede revertir de forma segura la migración de contenido/media web.'
      );
    }
    for (const tableName of [...TABLES].reverse()) {
      const existingName = inventoryTableName(await tableInventory(queryInterface), tableName);
      if (existingName) await queryInterface.dropTable(existingName);
    }
  },
};
