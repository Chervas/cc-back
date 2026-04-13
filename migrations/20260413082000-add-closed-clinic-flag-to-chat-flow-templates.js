'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('ChatFlowTemplates');
    if (!table.show_when_clinic_closed) {
      await queryInterface.addColumn('ChatFlowTemplates', 'show_when_clinic_closed', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        after: 'icon_type',
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('ChatFlowTemplates');
    if (table.show_when_clinic_closed) {
      await queryInterface.removeColumn('ChatFlowTemplates', 'show_when_clinic_closed');
    }
  },
};
