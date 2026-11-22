'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('GruposClinicas');
    if (!columns.meta_ad_account_assignment_updated_at) {
      await queryInterface.addColumn('GruposClinicas', 'meta_ad_account_assignment_updated_at', {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Set when Meta Ads destinations are explicitly configured, including an empty selection',
      });
    }
  },

  async down() {
    throw new Error('meta_ad_account_assignment_marker_preserved_rollback_code_only');
  },
};
