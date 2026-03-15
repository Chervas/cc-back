'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('AutomationFlowTemplatesV2', 'trigger_config', {
      type: Sequelize.JSON,
      allowNull: true,
      after: 'trigger_type',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('AutomationFlowTemplatesV2', 'trigger_config');
  },
};
