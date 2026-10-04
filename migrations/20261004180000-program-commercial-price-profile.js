'use strict';
// Additive only. Do not rewrite prices, legacy purchases or catalog approvals.
module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('TreatmentPrograms');
    if (!columns.price_profile) await queryInterface.addColumn('TreatmentPrograms', 'price_profile', { type: Sequelize.JSON, allowNull: true });
  },
  async down() { throw new Error('Preserve the program fiscal profile and its revisions; rollback application code, not financial evidence.'); },
};
