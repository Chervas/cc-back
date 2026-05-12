'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('Tratamientos');
    if (!table.automation_template_bindings) {
      await queryInterface.addColumn('Tratamientos', 'automation_template_bindings', {
        type: Sequelize.JSON,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('Tratamientos');
    if (table.automation_template_bindings) {
      await queryInterface.removeColumn('Tratamientos', 'automation_template_bindings');
    }
  },
};
