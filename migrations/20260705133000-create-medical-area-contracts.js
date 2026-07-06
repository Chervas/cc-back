'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const tableNames = tables.map((table) => (typeof table === 'string' ? table : table.tableName || table.table_name));
    if (tableNames.includes('MedicalAreaContracts')) {
      return;
    }

    await queryInterface.createTable('MedicalAreaContracts', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false,
      },
      code: {
        type: Sequelize.STRING(80),
        allowNull: false,
      },
      contract_json: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      version: {
        type: Sequelize.STRING(80),
        allowNull: false,
        defaultValue: 'custom-v1',
      },
      active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      updated_by: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('MedicalAreaContracts', ['code'], {
      unique: true,
      name: 'ux_medical_area_contracts_code',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('MedicalAreaContracts', 'ux_medical_area_contracts_code').catch(() => {});
    await queryInterface.dropTable('MedicalAreaContracts');
  },
};
