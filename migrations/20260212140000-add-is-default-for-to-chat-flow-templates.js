'use strict';

/**
 * Añade is_default_for al catálogo de plantillas de flujos de chat.
 * - JSON nullable
 * - default: null
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('ChatFlowTemplates', 'is_default_for', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('ChatFlowTemplates', 'is_default_for');
  },
};
