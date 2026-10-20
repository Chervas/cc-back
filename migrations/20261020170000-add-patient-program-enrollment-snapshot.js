'use strict';
// Additive storage only. No enrollment, balance, booking, price or message is
// created here. Existing budget-backed purchases remain completely unchanged.
module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('PatientVouchers');
    if (!columns.program_snapshot) await queryInterface.addColumn('PatientVouchers', 'program_snapshot', {
      type: Sequelize.JSON, allowNull: true,
    });
  },
  async down() {
    throw new Error('Preserve immutable program enrollment history; roll back application code, not enrolled patient evidence.');
  },
};
