'use strict';

const {
  DEFAULT_TABLE,
  migrateWebIntakeRuntimePlaintextSecrets,
} = require('../src/lib/webRuntimeSecretMigration');

async function describeOrNull(queryInterface) {
  try {
    return await queryInterface.describeTable(DEFAULT_TABLE);
  } catch (error) {
    if (/doesn.t exist|unknown table|no description found/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    let description = await describeOrNull(queryInterface);
    // La migración de creación puede no haberse ejecutado aún en una base
    // nueva. En ese caso no hay plaintext heredado que recuperar.
    if (!description) return;

    for (const column of ['source_hmac_envelope', 'target_hmac_envelope']) {
      if (!description[column]) {
        await queryInterface.addColumn(DEFAULT_TABLE, column, {
          type: Sequelize.TEXT,
          allowNull: true,
        });
      }
    }
    description = await describeOrNull(queryInterface);
    await migrateWebIntakeRuntimePlaintextSecrets(queryInterface, description, {
      table: DEFAULT_TABLE,
    });
  },

  // Irreversible por diseño: nunca se vuelve a materializar un secreto en
  // plaintext. Un rollback de código debe seguir leyendo los envelopes.
  async down() {},
};
