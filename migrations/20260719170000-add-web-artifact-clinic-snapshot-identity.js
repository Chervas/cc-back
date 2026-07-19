'use strict';

const TABLE = 'WebArtifacts';
const COLUMN = 'clinic_snapshot_hash';
const LEGACY_INDEX = 'uniq_web_artifacts_revision_renderer_target';
const TARGET_INDEX = 'uniq_web_artifacts_revision_renderer_target_clinic';
const LEGACY_FIELDS = ['revision_id', 'renderer_version', 'environment', 'base_url_hash', 'runtime_config_hash'];
const TARGET_FIELDS = [...LEGACY_FIELDS, COLUMN];

function migrationError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function indexFields(index) {
  return (Array.isArray(index?.fields) ? index.fields : [])
    .map((field) => String(field?.attribute || field?.name || field || ''));
}

function assertIndex(rows, name, fields, unique = true) {
  const found = rows.find((candidate) => String(candidate?.name || '') === name);
  if (!found) return false;
  const actual = indexFields(found);
  if (Boolean(found.unique) !== Boolean(unique) || JSON.stringify(actual) !== JSON.stringify(fields)) {
    throw migrationError(
      'web_artifact_clinic_snapshot_index_incompatible',
      `El índice ${name} existe con una definición incompatible.`,
      { index: name, expected_fields: fields, actual_fields: actual, expected_unique: Boolean(unique) }
    );
  }
  return true;
}

async function indexes(queryInterface) {
  if (typeof queryInterface.showIndex !== 'function') {
    throw migrationError(
      'web_artifact_clinic_snapshot_introspection_unavailable',
      `No se pueden inspeccionar de forma segura los índices de ${TABLE}.`
    );
  }
  return queryInterface.showIndex(TABLE);
}

async function rows(queryInterface, Sequelize, sql) {
  return queryInterface.sequelize.query(sql, { type: Sequelize.QueryTypes.SELECT });
}

async function assertTable(queryInterface) {
  const description = await queryInterface.describeTable(TABLE);
  const required = ['id', 'artifact_hash', ...LEGACY_FIELDS];
  const missing = required.filter((field) => !description[field]);
  if (missing.length) {
    throw migrationError(
      'web_artifact_clinic_snapshot_table_incompatible',
      `${TABLE} no cumple el contrato previo requerido.`,
      { missing_columns: missing }
    );
  }
  return description;
}

async function assertNoLegacyDuplicates(queryInterface, Sequelize) {
  const table = queryInterface.queryGenerator.quoteTable(TABLE);
  const fields = LEGACY_FIELDS.map((field) => queryInterface.queryGenerator.quoteIdentifier(field));
  const duplicates = await rows(
    queryInterface,
    Sequelize,
    `SELECT ${fields.join(', ')}, COUNT(*) AS artifact_count FROM ${table} `
      + `GROUP BY ${fields.join(', ')} HAVING COUNT(*) > 1 LIMIT 20`
  );
  if (duplicates.length) {
    throw migrationError(
      'web_artifact_clinic_snapshot_down_blocked',
      'No se puede restaurar la identidad antigua: ya existen artefactos distintos por clínica.',
      { duplicate_targets: duplicates }
    );
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    let description = await assertTable(queryInterface);
    let current = await indexes(queryInterface);
    const hasLegacy = assertIndex(current, LEGACY_INDEX, LEGACY_FIELDS);
    const hasTarget = assertIndex(current, TARGET_INDEX, TARGET_FIELDS);

    if (!description[COLUMN]) {
      await queryInterface.addColumn(TABLE, COLUMN, {
        type: Sequelize.STRING(64),
        allowNull: true,
      });
    }

    const table = queryInterface.queryGenerator.quoteTable(TABLE);
    const id = queryInterface.queryGenerator.quoteIdentifier('id');
    const artifactHash = queryInterface.queryGenerator.quoteIdentifier('artifact_hash');
    const clinicHash = queryInterface.queryGenerator.quoteIdentifier(COLUMN);
    // Legacy rows cannot be reconstructed from their old manifest. Give each a
    // stable, non-colliding sentinel so it is never reused for a new clinic
    // projection; the next compilation creates a correctly identified row.
    await queryInterface.sequelize.query(
      `UPDATE ${table} SET ${clinicHash} = SHA2(CONCAT('legacy:', ${id}, ':', ${artifactHash}), 256) `
        + `WHERE ${clinicHash} IS NULL OR ${clinicHash} NOT REGEXP '^[a-f0-9]{64}$'`
    );
    const invalid = await rows(
      queryInterface,
      Sequelize,
      `SELECT ${id} AS id FROM ${table} WHERE ${clinicHash} IS NULL `
        + `OR ${clinicHash} NOT REGEXP '^[a-f0-9]{64}$' LIMIT 20`
    );
    if (invalid.length) {
      throw migrationError(
        'web_artifact_clinic_snapshot_backfill_incomplete',
        'No se pudo completar la identidad de clínica de todos los artefactos.',
        { artifact_ids: invalid.map((entry) => String(entry.id || '')) }
      );
    }

    description = await queryInterface.describeTable(TABLE);
    if (description[COLUMN]?.allowNull !== false) {
      await queryInterface.changeColumn(TABLE, COLUMN, {
        type: Sequelize.STRING(64),
        allowNull: false,
      });
    }

    if (!hasTarget) {
      await queryInterface.addIndex(TABLE, TARGET_FIELDS, { name: TARGET_INDEX, unique: true });
    }
    current = await indexes(queryInterface);
    assertIndex(current, TARGET_INDEX, TARGET_FIELDS);

    if (hasLegacy) await queryInterface.removeIndex(TABLE, LEGACY_INDEX);
    current = await indexes(queryInterface);
    assertIndex(current, TARGET_INDEX, TARGET_FIELDS);
    if (current.some((index) => String(index?.name || '') === LEGACY_INDEX)) {
      throw migrationError(
        'web_artifact_clinic_snapshot_legacy_index_present',
        'El índice de identidad antiguo sigue activo.'
      );
    }
  },

  async down(queryInterface, Sequelize) {
    const description = await assertTable(queryInterface);
    if (!description[COLUMN]) return;
    await assertNoLegacyDuplicates(queryInterface, Sequelize);
    let current = await indexes(queryInterface);
    if (!assertIndex(current, LEGACY_INDEX, LEGACY_FIELDS)) {
      await queryInterface.addIndex(TABLE, LEGACY_FIELDS, { name: LEGACY_INDEX, unique: true });
    }
    current = await indexes(queryInterface);
    assertIndex(current, LEGACY_INDEX, LEGACY_FIELDS);
    if (assertIndex(current, TARGET_INDEX, TARGET_FIELDS)) {
      await queryInterface.removeIndex(TABLE, TARGET_INDEX);
    }
    await queryInterface.removeColumn(TABLE, COLUMN);
  },

  assertIndex,
  assertNoLegacyDuplicates,
};
