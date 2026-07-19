'use strict';

const TABLE = 'WebIntakeRuntimeReconciliations';
const {
  migrateWebIntakeRuntimePlaintextSecrets,
} = require('../src/lib/webRuntimeSecretMigration');

async function describeOrNull(queryInterface) {
  try {
    return await queryInterface.describeTable(TABLE);
  } catch (error) {
    if (/doesn.t exist|unknown table|no description found/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

function columns(Sequelize) {
  return {
    id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
    scope_type: { type: Sequelize.ENUM('clinic', 'group'), allowNull: false },
    scope_id: { type: Sequelize.INTEGER, allowNull: false },
    generation: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    source_runtime_hash: { type: Sequelize.STRING(64), allowNull: false },
    source_runtime_fingerprint: { type: Sequelize.STRING(64), allowNull: false },
    target_runtime_hash: { type: Sequelize.STRING(64), allowNull: false },
    target_runtime_fingerprint: { type: Sequelize.STRING(64), allowNull: false },
    target_hmac_envelope: { type: Sequelize.TEXT, allowNull: true },
    source_hmac_envelope: { type: Sequelize.TEXT, allowNull: true },
    source_config_patch: { type: Sequelize.JSON, allowNull: false },
    target_config_patch: { type: Sequelize.JSON, allowNull: false },
    status: {
      type: Sequelize.ENUM('pending', 'preparing', 'deploying', 'rolling_back', 'grace', 'completed', 'failed'),
      allowNull: false,
      defaultValue: 'pending',
    },
    expected_deployments: { type: Sequelize.JSON, allowNull: false },
    last_error_code: { type: Sequelize.STRING(128), allowNull: true },
    last_error_message: { type: Sequelize.TEXT, allowNull: true },
    committed_at: { type: Sequelize.DATE, allowNull: true },
    grace_expires_at: { type: Sequelize.DATE, allowNull: true },
    last_recovery_request_id: { type: Sequelize.STRING(80), allowNull: true },
    last_recovery_request_hash: { type: Sequelize.STRING(64), allowNull: true },
    last_recovery_action: { type: Sequelize.STRING(32), allowNull: true },
    last_recovery_generation: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
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
}

async function ensureIndex(queryInterface, name, fields, unique = false) {
  const indexes = await queryInterface.showIndex(TABLE);
  const existing = indexes.find((index) => index.name === name);
  if (existing) {
    const actualFields = (existing.fields || []).map((field) => field.attribute || field.name);
    if (Boolean(existing.unique) !== unique || actualFields.join(',') !== fields.join(',')) {
      throw new Error(`Incompatible index ${name} on ${TABLE}`);
    }
    return;
  }
  await queryInterface.addIndex(TABLE, fields, { name, unique });
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const definition = columns(Sequelize);
    let description = await describeOrNull(queryInterface);
    if (!description) {
      await queryInterface.createTable(TABLE, definition);
      description = await describeOrNull(queryInterface);
    } else {
      // Una ejecución interrumpida puede dejar tabla pero no todas las
      // columnas. Reanudar es seguro y nunca elimina/reinterpreta datos.
      for (const [name, column] of Object.entries(definition)) {
        if (!description[name]) await queryInterface.addColumn(TABLE, name, column);
      }
      description = await describeOrNull(queryInterface);
      // ENUM puede existir con una definición de una ejecución anterior. La
      // operación es idempotente y amplía únicamente los estados conocidos.
      await queryInterface.changeColumn(TABLE, 'status', definition.status);
    }
    await migrateWebIntakeRuntimePlaintextSecrets(queryInterface, description, { table: TABLE });
    await ensureIndex(
      queryInterface,
      'uniq_web_intake_runtime_reconciliation_scope',
      ['scope_type', 'scope_id'],
      true
    );
    await ensureIndex(
      queryInterface,
      'idx_web_intake_runtime_reconciliation_status',
      ['status', 'updated_at'],
      false
    );
  },

  async down(queryInterface) {
    if (await describeOrNull(queryInterface)) await queryInterface.dropTable(TABLE);
  },
};
