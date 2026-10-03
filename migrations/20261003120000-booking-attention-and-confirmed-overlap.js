'use strict';

// Additive only. No clinic, machine or professional is enabled by migration.
module.exports = {
  async up(queryInterface, Sequelize) {
    for (const [table, column, definition] of [
      ['BookingEquipment', 'attention_policy', { type: Sequelize.JSON, allowNull: true }],
      ['Instalaciones', 'allow_overlap_confirmation', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }],
      ['DoctorClinicas', 'allow_overlap_confirmation', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false }],
    ]) {
      const schema = await queryInterface.describeTable(table);
      if (!schema[column]) await queryInterface.addColumn(table, column, definition);
    }
  },
  async down() { throw new Error('Conserva las reglas y snapshots de intervención; el rollback es de código compatible, no borrado de datos.'); },
};
