'use strict';

const TABLE = 'WebIntakeRuntimeReconciliations';

async function describeOrNull(queryInterface) {
  try {
    return await queryInterface.describeTable(TABLE);
  } catch (error) {
    if (/doesn.t exist|unknown table|no description found/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const description = await describeOrNull(queryInterface);
    if (!description) return;
    const additions = {
      last_recovery_request_id: { type: Sequelize.STRING(80), allowNull: true },
      last_recovery_request_hash: { type: Sequelize.STRING(64), allowNull: true },
      last_recovery_action: { type: Sequelize.STRING(32), allowNull: true },
      last_recovery_generation: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!description[name]) await queryInterface.addColumn(TABLE, name, definition);
    }
  },

  // La metadata de idempotencia forma parte de la evidencia administrativa.
  // Un rollback destructivo podría convertir un replay en una segunda acción.
  async down() {},
};
