'use strict';

async function indexExists(queryInterface, tableName, indexName) {
  const indexes = await queryInterface.showIndex(tableName);
  return indexes.some((index) => index.name === indexName);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('CitasPacientes');

    if (!table.source_system) {
      await queryInterface.addColumn('CitasPacientes', 'source_system', {
        type: Sequelize.STRING(40),
        allowNull: true,
      });
    }

    if (!table.source_reference) {
      await queryInterface.addColumn('CitasPacientes', 'source_reference', {
        type: Sequelize.STRING(120),
        allowNull: true,
      });
    }

    if (!table.import_metadata) {
      await queryInterface.addColumn('CitasPacientes', 'import_metadata', {
        type: Sequelize.JSON,
        allowNull: true,
      });
    }

    if (!await indexExists(queryInterface, 'CitasPacientes', 'citas_pacientes_import_ref_uq')) {
      await queryInterface.addIndex('CitasPacientes', ['clinica_id', 'source_system', 'source_reference'], {
        name: 'citas_pacientes_import_ref_uq',
        unique: true,
      });
    }
  },

  async down(queryInterface) {
    if (await indexExists(queryInterface, 'CitasPacientes', 'citas_pacientes_import_ref_uq')) {
      await queryInterface.removeIndex('CitasPacientes', 'citas_pacientes_import_ref_uq');
    }

    const table = await queryInterface.describeTable('CitasPacientes');
    if (table.import_metadata) await queryInterface.removeColumn('CitasPacientes', 'import_metadata');
    if (table.source_reference) await queryInterface.removeColumn('CitasPacientes', 'source_reference');
    if (table.source_system) await queryInterface.removeColumn('CitasPacientes', 'source_system');
  },
};
