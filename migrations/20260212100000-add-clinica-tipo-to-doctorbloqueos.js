'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tableName = 'DoctorBloqueos';
    const table = await queryInterface.describeTable(tableName);

    if (!table.clinica_id) {
      await queryInterface.addColumn(tableName, 'clinica_id', {
        type: Sequelize.INTEGER,
        allowNull: true,
      });
      await queryInterface.addIndex(tableName, ['clinica_id'], {
        name: 'idx_doctorbloqueos_clinica_id',
      });
    }

    if (!table.tipo) {
      await queryInterface.addColumn(tableName, 'tipo', {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'ausencia',
      });
      await queryInterface.addIndex(tableName, ['tipo'], {
        name: 'idx_doctorbloqueos_tipo',
      });
    }
  },

  async down(queryInterface) {
    const tableName = 'DoctorBloqueos';
    const table = await queryInterface.describeTable(tableName);

    if (table.tipo) {
      await queryInterface.removeIndex(tableName, 'idx_doctorbloqueos_tipo').catch(() => null);
      await queryInterface.removeColumn(tableName, 'tipo');
    }

    if (table.clinica_id) {
      await queryInterface.removeIndex(tableName, 'idx_doctorbloqueos_clinica_id').catch(() => null);
      await queryInterface.removeColumn(tableName, 'clinica_id');
    }
  },
};

