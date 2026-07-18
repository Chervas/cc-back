'use strict';

function tableName(value) {
  if (typeof value === 'string') return value;
  return value?.tableName || value?.name || '';
}

async function tableExists(queryInterface, name) {
  const tables = await queryInterface.showAllTables();
  return tables.some((table) => tableName(table).toLowerCase() === name.toLowerCase());
}

async function assertDependencies(queryInterface, names) {
  const tables = await queryInterface.showAllTables();
  const available = new Set(tables.map((table) => tableName(table).toLowerCase()));
  const missing = names.filter((name) => !available.has(name.toLowerCase()));
  if (missing.length) {
    throw new Error(
      `No se puede crear el puente de destinos; faltan tablas previas: ${missing.join(', ')}. `
      + 'Aplica primero las migraciones web y de campanas en el orden documentado.'
    );
  }
}

async function assertTableComplete(queryInterface, name, requiredColumns, typeContracts = {}) {
  const definition = await queryInterface.describeTable(name);
  const missing = requiredColumns.filter((column) => !definition[column]);
  if (missing.length) {
    throw new Error(
      `La migracion encontro ${name} creado de forma parcial; faltan columnas: ${missing.join(', ')}. `
      + 'No se modificara una tabla ambigua automaticamente.'
    );
  }
  const mismatches = [];
  for (const [column, expected] of Object.entries(typeContracts)) {
    const metadata = definition[column];
    const actualType = String(metadata?.type || '').toUpperCase();
    if (expected.type && actualType && !expected.type.test(actualType)) {
      mismatches.push(`${column}:tipo=${actualType}`);
    }
    if (typeof expected.allowNull === 'boolean' && metadata?.allowNull !== expected.allowNull) {
      mismatches.push(`${column}:allowNull=${String(metadata?.allowNull)}`);
    }
  }
  if (mismatches.length) {
    throw new Error(
      `La migracion encontro ${name} con un contrato incompatible: ${mismatches.join(', ')}. `
      + 'No se alterara una tabla existente automaticamente.'
    );
  }
}

async function assertForeignKeys(queryInterface, table, expectedReferences) {
  if (typeof queryInterface.getForeignKeyReferencesForTable !== 'function') {
    throw new Error(`No se pueden verificar las claves foraneas de ${table}.`);
  }
  const references = await queryInterface.getForeignKeyReferencesForTable(table);
  const normalized = references.map((reference) => ({
    column: String(reference.columnName || reference.column_name || '').toLowerCase(),
    table: tableName(reference.referencedTableName || reference.referenced_table_name).toLowerCase(),
    referencedColumn: String(reference.referencedColumnName || reference.referenced_column_name || '').toLowerCase(),
  }));
  const missing = expectedReferences.filter((expected) => !normalized.some((reference) => (
    reference.column === expected.column.toLowerCase()
    && reference.table === expected.table.toLowerCase()
    && reference.referencedColumn === expected.referencedColumn.toLowerCase()
  )));
  if (missing.length) {
    throw new Error(
      `La migracion encontro ${table} sin claves foraneas requeridas: `
      + missing.map((item) => `${item.column}->${item.table}.${item.referencedColumn}`).join(', ')
      + '. No se modificara una tabla ambigua automaticamente.'
    );
  }
}

async function ensureIndex(queryInterface, table, fields, options) {
  const indexes = await queryInterface.showIndex(table);
  const existing = indexes.find((index) => index.name === options.name);
  if (existing) {
    const actualFields = (existing.fields || [])
      .map((field) => field.attribute || field.name || field)
      .join(',');
    if (actualFields !== fields.join(',') || Boolean(existing.unique) !== Boolean(options.unique)) {
      const error = new Error(`${table}.${options.name} existe con un contrato incompatible`);
      error.code = 'campaign_destination_migration_incompatible_index';
      error.details = { table, index: options.name, expected_fields: fields };
      throw error;
    }
    return;
  }
  await queryInterface.addIndex(table, fields, options);
}

function normalizeCheckClause(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\\'/g, "'")
    .replace(/_[a-z0-9]+(?=')/g, '')
    .replace(/[`\s()]/g, '');
}

async function getCheckConstraints(queryInterface, tableName) {
  if (typeof queryInterface.getCheckConstraints === 'function') {
    return queryInterface.getCheckConstraints(tableName);
  }
  if (queryInterface.sequelize?.query) {
    const [rows] = await queryInterface.sequelize.query(
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
    return rows || [];
  }
  throw new Error(`No se pueden verificar las restricciones CHECK de ${tableName}`);
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
  const existing = constraints.find((constraint) => (
    String(constraint.constraint_name || constraint.constraintName || '').toLowerCase()
      === definition.name.toLowerCase()
  ));
  if (existing) {
    const type = String(existing.constraint_type || existing.constraintType || 'CHECK').toUpperCase();
    const clause = existing.check_clause || existing.checkClause;
    if (type !== 'CHECK' || normalizeCheckClause(clause) !== normalizeCheckClause(definition.expression)) {
      const error = new Error(`${tableName}.${definition.name} existe con un contrato incompatible`);
      error.code = 'campaign_destination_migration_incompatible_constraint';
      error.details = { table: tableName, constraint: definition.name };
      throw error;
    }
    return;
  }
  const violationCount = await countCheckViolations(queryInterface, tableName, definition.expression);
  if (violationCount > 0) {
    const error = new Error(`${tableName} contiene ${violationCount} fila(s) que incumplen ${definition.name}`);
    error.code = 'campaign_destination_migration_constraint_data_violation';
    error.details = { table: tableName, constraint: definition.name, violation_count: violationCount };
    throw error;
  }
  await queryInterface.addConstraint(tableName, {
    fields: definition.fields,
    type: 'check',
    name: definition.name,
    where: Sequelize.literal(definition.expression),
  });
}

async function getForeignKeyActions(queryInterface, tableName) {
  if (typeof queryInterface.getForeignKeyActions === 'function') {
    return queryInterface.getForeignKeyActions(tableName);
  }
  if (queryInterface.sequelize?.query) {
    const [rows] = await queryInterface.sequelize.query(
      `SELECT kcu.COLUMN_NAME AS column_name,
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
      { replacements: { tableName } }
    );
    return rows || [];
  }
  throw new Error(`No se pueden verificar las acciones de las claves foraneas de ${tableName}`);
}

async function assertCheckCompatibleForeignKeys(queryInterface, tableName, columns) {
  const foreignKeys = await getForeignKeyActions(queryInterface, tableName);
  for (const column of columns) {
    const foreignKey = foreignKeys.find((item) => (
      String(item.column_name || item.columnName || '').toLowerCase() === column.toLowerCase()
    ));
    const updateRule = String(foreignKey?.update_rule || foreignKey?.updateRule || '').toUpperCase();
    if (!foreignKey || !['RESTRICT', 'NO ACTION'].includes(updateRule)) {
      const error = new Error(
        `${tableName}.${column} debe usar ON UPDATE RESTRICT/NO ACTION para ser compatible con CHECK`
      );
      error.code = 'campaign_destination_migration_incompatible_foreign_key_action';
      error.details = { table: tableName, column, update_rule: updateRule || null };
      throw error;
    }
  }
}

const SCOPE_CHECK = Object.freeze({
  fields: ['scope_type', 'clinica_id', 'grupo_clinica_id'],
  expression: "(scope_type = 'clinic' AND clinica_id IS NOT NULL AND grupo_clinica_id IS NULL) OR (scope_type = 'group' AND clinica_id IS NULL AND grupo_clinica_id IS NOT NULL)",
});

const TARGET_CHECK = Object.freeze({
  fields: ['target_kind', 'treatment_id', 'treatment_identity'],
  expression: "(target_kind = 'general' AND treatment_id IS NULL AND treatment_identity = 0) OR (target_kind = 'treatment' AND treatment_id IS NOT NULL AND treatment_identity = treatment_id AND treatment_identity > 0)",
});

/**
 * Durable bridge between a marketing strategy target and a verified Web
 * publication. Provider operations live in the child table so one account can
 * fail/read back/roll back without lying about the rest of the aggregate.
 *
 * `treatment_identity` is the null-safe projection of `treatment_id`: zero is
 * reserved for the general target. MySQL unique indexes consider NULL values
 * distinct, therefore indexing the nullable FK directly would allow duplicate
 * general bindings.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await assertDependencies(queryInterface, [
      'Campaigns', 'Tratamientos', 'Clinicas', 'GruposClinicas', 'WebProjects',
      'WebPublications', 'WebRevisions', 'WebArtifacts', 'ManagedCampaigns', 'JobRequests',
    ]);
    if (!await tableExists(queryInterface, 'CampaignDestinationBindings')) await queryInterface.createTable('CampaignDestinationBindings', {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      strategy_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Campaigns', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      target_kind: {
        type: Sequelize.ENUM('general', 'treatment'),
        allowNull: false,
      },
      treatment_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Tratamientos', key: 'id_tratamiento' },
        // Los IDs no se renumeran; RESTRICT evita el error MySQL 3823 al aplicar el CHECK de target.
        onUpdate: 'RESTRICT',
        onDelete: 'RESTRICT',
      },
      treatment_identity: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: 'Null-safe treatment_id projection; 0 means the general target',
      },
      mode: {
        type: Sequelize.ENUM('connect_only', 'guided_improvement', 'managed_service'),
        allowNull: false,
      },
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
      project_id: {
        type: Sequelize.STRING(36), allowNull: false,
        references: { model: 'WebProjects', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      publication_id: {
        type: Sequelize.STRING(36), allowNull: false,
        references: { model: 'WebPublications', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      revision_id: {
        type: Sequelize.STRING(36), allowNull: false,
        references: { model: 'WebRevisions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      artifact_id: {
        type: Sequelize.STRING(36), allowNull: false,
        references: { model: 'WebArtifacts', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      destination_url: { type: Sequelize.TEXT, allowNull: false },
      destination_digest: { type: Sequelize.STRING(64), allowNull: false },
      active_destination_url: { type: Sequelize.TEXT, allowNull: true },
      active_destination_digest: { type: Sequelize.STRING(64), allowNull: true },
      landing_event_id: { type: Sequelize.STRING(80), allowNull: false },
      destination_ready_event_id: { type: Sequelize.STRING(80), allowNull: true },
      publication_status: {
        type: Sequelize.ENUM('verified', 'invalid', 'retired'),
        allowNull: false,
        defaultValue: 'verified',
      },
      destination_status: {
        type: Sequelize.ENUM(
          'ready', 'apply_queued', 'applying', 'readback_pending', 'active',
          'rollback_queued', 'rolling_back', 'rolled_back', 'blocked', 'failed', 'drifted'
        ),
        allowNull: false,
        defaultValue: 'ready',
      },
      capability_status: {
        type: Sequelize.ENUM('blocked', 'ready', 'active'),
        allowNull: false,
        defaultValue: 'ready',
      },
      authorization: { type: Sequelize.JSON, allowNull: false },
      last_error_code: { type: Sequelize.STRING(128), allowNull: true },
      last_error_details: { type: Sequelize.JSON, allowNull: true },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      active_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });

    await assertTableComplete(queryInterface, 'CampaignDestinationBindings', [
      'id', 'strategy_id', 'target_kind', 'treatment_id', 'treatment_identity', 'mode',
      'scope_type', 'clinica_id', 'grupo_clinica_id', 'project_id', 'publication_id', 'revision_id', 'artifact_id',
      'destination_url', 'destination_digest', 'landing_event_id', 'publication_status',
      'destination_status', 'capability_status', 'authorization', 'version',
    ], {
      id: { type: /CHAR|VARCHAR|STRING/, allowNull: false },
      strategy_id: { type: /INT/, allowNull: false },
      target_kind: { type: /ENUM/, allowNull: false },
      treatment_id: { type: /INT/, allowNull: true },
      treatment_identity: { type: /INT/, allowNull: false },
      scope_type: { type: /ENUM/, allowNull: false },
      clinica_id: { type: /INT/, allowNull: true },
      grupo_clinica_id: { type: /INT/, allowNull: true },
      project_id: { type: /CHAR|VARCHAR|STRING/, allowNull: false },
      publication_id: { type: /CHAR|VARCHAR|STRING/, allowNull: false },
      revision_id: { type: /CHAR|VARCHAR|STRING/, allowNull: false },
      artifact_id: { type: /CHAR|VARCHAR|STRING/, allowNull: false },
    });
    await assertForeignKeys(queryInterface, 'CampaignDestinationBindings', [
      { column: 'strategy_id', table: 'Campaigns', referencedColumn: 'id' },
      { column: 'treatment_id', table: 'Tratamientos', referencedColumn: 'id_tratamiento' },
      { column: 'clinica_id', table: 'Clinicas', referencedColumn: 'id_clinica' },
      { column: 'grupo_clinica_id', table: 'GruposClinicas', referencedColumn: 'id_grupo' },
      { column: 'project_id', table: 'WebProjects', referencedColumn: 'id' },
      { column: 'publication_id', table: 'WebPublications', referencedColumn: 'id' },
      { column: 'revision_id', table: 'WebRevisions', referencedColumn: 'id' },
      { column: 'artifact_id', table: 'WebArtifacts', referencedColumn: 'id' },
    ]);
    await assertCheckCompatibleForeignKeys(
      queryInterface,
      'CampaignDestinationBindings',
      ['treatment_id', 'clinica_id', 'grupo_clinica_id']
    );
    await ensureCheckConstraint(queryInterface, Sequelize, 'CampaignDestinationBindings', {
      ...SCOPE_CHECK,
      name: 'chk_campaign_destination_bindings_scope',
    });
    await ensureCheckConstraint(queryInterface, Sequelize, 'CampaignDestinationBindings', {
      ...TARGET_CHECK,
      name: 'chk_campaign_destination_bindings_target',
    });
    await ensureIndex(queryInterface, 'CampaignDestinationBindings', ['strategy_id', 'target_kind', 'treatment_identity'], {
      name: 'uniq_campaign_destination_binding_target_nullsafe',
      unique: true,
    });
    await ensureIndex(queryInterface, 'CampaignDestinationBindings', ['landing_event_id'], {
      name: 'uniq_campaign_destination_binding_landing_event',
      unique: true,
    });
    await ensureIndex(queryInterface, 'CampaignDestinationBindings', ['strategy_id', 'target_kind', 'treatment_id'], {
      name: 'idx_campaign_destination_binding_target',
    });
    await ensureIndex(queryInterface, 'CampaignDestinationBindings', ['publication_id', 'publication_status'], {
      name: 'idx_campaign_destination_binding_publication',
    });
    await ensureIndex(queryInterface, 'CampaignDestinationBindings', ['destination_status', 'updated_at'], {
      name: 'idx_campaign_destination_binding_status',
    });

    if (!await tableExists(queryInterface, 'CampaignDestinationBindingAccounts')) await queryInterface.createTable('CampaignDestinationBindingAccounts', {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      binding_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        references: { model: 'CampaignDestinationBindings', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      managed_campaign_id: {
        type: Sequelize.STRING(36),
        allowNull: true,
        references: { model: 'ManagedCampaigns', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      provider: { type: Sequelize.ENUM('google_ads', 'meta_ads'), allowNull: false },
      customer_id: { type: Sequelize.STRING(64), allowNull: false },
      campaign_id: { type: Sequelize.STRING(128), allowNull: false },
      family: {
        type: Sequelize.ENUM('google_search', 'google_pmax', 'meta_instant_form', 'meta_reach', 'unsupported'),
        allowNull: false,
      },
      pmax_url_expansion: {
        type: Sequelize.ENUM('not_applicable', 'pending', 'enabled', 'disabled'),
        allowNull: false,
        defaultValue: 'not_applicable',
      },
      state: {
        type: Sequelize.ENUM(
          'ready', 'apply_queued', 'applying', 'readback_pending', 'active',
          'rollback_queued', 'rolling_back', 'rolled_back', 'blocked', 'failed', 'drifted'
        ),
        allowNull: false,
        defaultValue: 'ready',
      },
      before_state: { type: Sequelize.JSON, allowNull: true },
      desired_state: { type: Sequelize.JSON, allowNull: false },
      observed_state: { type: Sequelize.JSON, allowNull: true },
      operation_digest: { type: Sequelize.STRING(64), allowNull: false },
      apply_event_id: { type: Sequelize.STRING(80), allowNull: true },
      readback_event_id: { type: Sequelize.STRING(80), allowNull: true },
      rollback_event_id: { type: Sequelize.STRING(80), allowNull: true },
      apply_job_request_id: {
        type: Sequelize.INTEGER.UNSIGNED, allowNull: true,
        references: { model: 'JobRequests', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      rollback_job_request_id: {
        type: Sequelize.INTEGER.UNSIGNED, allowNull: true,
        references: { model: 'JobRequests', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      authorization: { type: Sequelize.JSON, allowNull: false },
      last_error_code: { type: Sequelize.STRING(128), allowNull: true },
      last_error_details: { type: Sequelize.JSON, allowNull: true },
      applied_at: { type: Sequelize.DATE, allowNull: true },
      readback_at: { type: Sequelize.DATE, allowNull: true },
      rolled_back_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });
    await assertTableComplete(queryInterface, 'CampaignDestinationBindingAccounts', [
      'id', 'binding_id', 'provider', 'customer_id', 'campaign_id', 'family',
      'pmax_url_expansion', 'state', 'desired_state', 'operation_digest',
      'authorization', 'created_at', 'updated_at',
    ], {
      id: { type: /CHAR|VARCHAR|STRING/, allowNull: false },
      binding_id: { type: /CHAR|VARCHAR|STRING/, allowNull: false },
      provider: { type: /ENUM/, allowNull: false },
      customer_id: { type: /CHAR|VARCHAR|STRING/, allowNull: false },
      campaign_id: { type: /CHAR|VARCHAR|STRING/, allowNull: false },
    });
    await assertForeignKeys(queryInterface, 'CampaignDestinationBindingAccounts', [
      { column: 'binding_id', table: 'CampaignDestinationBindings', referencedColumn: 'id' },
      { column: 'managed_campaign_id', table: 'ManagedCampaigns', referencedColumn: 'id' },
      { column: 'apply_job_request_id', table: 'JobRequests', referencedColumn: 'id' },
      { column: 'rollback_job_request_id', table: 'JobRequests', referencedColumn: 'id' },
    ]);
    await ensureIndex(queryInterface, 'CampaignDestinationBindingAccounts', ['binding_id', 'provider', 'customer_id', 'campaign_id'], {
      name: 'uniq_campaign_destination_binding_account',
      unique: true,
    });
    await ensureIndex(queryInterface, 'CampaignDestinationBindingAccounts', ['apply_event_id'], {
      name: 'uniq_campaign_destination_binding_apply_event',
      unique: true,
    });
    await ensureIndex(queryInterface, 'CampaignDestinationBindingAccounts', ['rollback_event_id'], {
      name: 'uniq_campaign_destination_binding_rollback_event',
      unique: true,
    });
    await ensureIndex(queryInterface, 'CampaignDestinationBindingAccounts', ['provider', 'customer_id', 'state'], {
      name: 'idx_campaign_destination_binding_account_state',
    });
    await ensureIndex(queryInterface, 'CampaignDestinationBindingAccounts', ['binding_id', 'state'], {
      name: 'idx_campaign_destination_binding_account_binding_state',
    });

    if (!await tableExists(queryInterface, 'CampaignDestinationBindingEvents')) await queryInterface.createTable('CampaignDestinationBindingEvents', {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      event_id: { type: Sequelize.STRING(80), allowNull: false },
      binding_id: {
        type: Sequelize.STRING(36), allowNull: false,
        references: { model: 'CampaignDestinationBindings', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      account_id: {
        type: Sequelize.STRING(36), allowNull: true,
        references: { model: 'CampaignDestinationBindingAccounts', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      event_type: {
        type: Sequelize.ENUM(
          'landing_published', 'destination_ready', 'apply_requested', 'apply_started',
          'readback_verified', 'readback_failed', 'rollback_requested', 'rollback_started',
          'rollback_verified', 'rollback_failed'
        ),
        allowNull: false,
      },
      event_digest: { type: Sequelize.STRING(64), allowNull: false },
      data: { type: Sequelize.JSON, allowNull: false },
      job_request_id: {
        type: Sequelize.INTEGER.UNSIGNED, allowNull: true,
        references: { model: 'JobRequests', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      actor_user_id: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await assertTableComplete(queryInterface, 'CampaignDestinationBindingEvents', [
      'id', 'event_id', 'binding_id', 'account_id', 'event_type', 'event_digest',
      'data', 'actor_user_id', 'created_at',
    ], {
      id: { type: /CHAR|VARCHAR|STRING/, allowNull: false },
      event_id: { type: /CHAR|VARCHAR|STRING/, allowNull: false },
      binding_id: { type: /CHAR|VARCHAR|STRING/, allowNull: false },
      account_id: { type: /CHAR|VARCHAR|STRING/, allowNull: true },
      event_type: { type: /ENUM/, allowNull: false },
    });
    await assertForeignKeys(queryInterface, 'CampaignDestinationBindingEvents', [
      { column: 'binding_id', table: 'CampaignDestinationBindings', referencedColumn: 'id' },
      { column: 'account_id', table: 'CampaignDestinationBindingAccounts', referencedColumn: 'id' },
      { column: 'job_request_id', table: 'JobRequests', referencedColumn: 'id' },
    ]);
    await ensureIndex(queryInterface, 'CampaignDestinationBindingEvents', ['event_id'], {
      unique: true, name: 'uniq_campaign_destination_binding_event_id',
    });
    await ensureIndex(queryInterface, 'CampaignDestinationBindingEvents', ['binding_id', 'created_at'], {
      name: 'idx_campaign_destination_binding_event_binding',
    });
    await ensureIndex(queryInterface, 'CampaignDestinationBindingEvents', ['account_id', 'created_at'], {
      name: 'idx_campaign_destination_binding_event_account',
    });
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'CampaignDestinationBindingEvents')) {
      await queryInterface.dropTable('CampaignDestinationBindingEvents');
    }
    if (await tableExists(queryInterface, 'CampaignDestinationBindingAccounts')) {
      await queryInterface.dropTable('CampaignDestinationBindingAccounts');
    }
    if (await tableExists(queryInterface, 'CampaignDestinationBindings')) {
      await queryInterface.dropTable('CampaignDestinationBindings');
    }
  },
};
