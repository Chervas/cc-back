'use strict';

/**
 * Catálogo de plantillas de flujos del chat (snippet web).
 *
 * Nota:
 * - Se guarda el JSON tal cual lo necesita el front (flows/flow/texts/appearance)
 *   para poder aplicar una plantilla a una configuración de IntakeConfig.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ChatFlowTemplates', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: Sequelize.STRING(255), allowNull: false, unique: true },
      tags: { type: Sequelize.JSON, allowNull: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      // Legacy (single-flow) template support
      flow: { type: Sequelize.JSON, allowNull: true },
      // Multi-flow support (preferred)
      flows: { type: Sequelize.JSON, allowNull: true },
      texts: { type: Sequelize.JSON, allowNull: true },
      appearance: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        onUpdate: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('ChatFlowTemplates');
  },
};

