'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('AutomationFlowCatalog');

    if (!table.template_key) {
      await queryInterface.addColumn('AutomationFlowCatalog', 'template_key', {
        type: Sequelize.STRING(120),
        allowNull: true,
        after: 'steps',
      });
    }

    if (!table.template_version) {
      await queryInterface.addColumn('AutomationFlowCatalog', 'template_version', {
        type: Sequelize.INTEGER,
        allowNull: true,
        after: 'template_key',
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('AutomationFlowCatalog');

    if (table.template_version) {
      await queryInterface.removeColumn('AutomationFlowCatalog', 'template_version');
    }

    if (table.template_key) {
      await queryInterface.removeColumn('AutomationFlowCatalog', 'template_key');
    }
  },
};
