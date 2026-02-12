'use strict';

/**
 * Añade icon_type al catálogo de plantillas de flujos de chat.
 * - string nullable
 * - default: 'whatsapp'
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('ChatFlowTemplates', 'icon_type', {
      type: Sequelize.STRING(50),
      allowNull: true,
      defaultValue: 'whatsapp',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('ChatFlowTemplates', 'icon_type');
  },
};

