'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('CitasPacientes');

    if (!table.created_by) {
      await queryInterface.addColumn('CitasPacientes', 'created_by', {
        type: Sequelize.INTEGER,
        allowNull: true,
        after: 'campana_id',
      });
    }

    if (!table.updated_by) {
      await queryInterface.addColumn('CitasPacientes', 'updated_by', {
        type: Sequelize.INTEGER,
        allowNull: true,
        after: 'created_by',
      });
    }
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable('CitasPacientes');

    if (table.updated_by) {
      await queryInterface.removeColumn('CitasPacientes', 'updated_by');
    }

    if (table.created_by) {
      await queryInterface.removeColumn('CitasPacientes', 'created_by');
    }
  },
};
