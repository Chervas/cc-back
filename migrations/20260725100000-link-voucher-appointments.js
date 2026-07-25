'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('CitasPacientes', 'voucher_id', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: true,
      references: { model: 'PatientVouchers', key: 'id' },
      onDelete: 'SET NULL',
      after: 'tratamiento_id',
    });
    await queryInterface.addIndex('CitasPacientes', ['voucher_id', 'estado', 'inicio'], {
      name: 'citas_pacientes_voucher_schedule_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'CitasPacientes',
      'citas_pacientes_voucher_schedule_idx',
    );
    await queryInterface.removeColumn('CitasPacientes', 'voucher_id');
  },
};
