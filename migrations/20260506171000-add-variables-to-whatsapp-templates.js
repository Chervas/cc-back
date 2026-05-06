'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const definition = await queryInterface.describeTable('WhatsappTemplates');
    if (!definition.variables) {
      await queryInterface.addColumn('WhatsappTemplates', 'variables', {
        type: Sequelize.JSON,
        allowNull: true,
      });
    }
    if (!definition.display_name) {
      await queryInterface.addColumn('WhatsappTemplates', 'display_name', {
        type: Sequelize.STRING(150),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const definition = await queryInterface.describeTable('WhatsappTemplates');
    if (definition.display_name) {
      await queryInterface.removeColumn('WhatsappTemplates', 'display_name');
    }
    if (definition.variables) {
      await queryInterface.removeColumn('WhatsappTemplates', 'variables');
    }
  },
};
