'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('ExternalCampaignAssignments', 'archive_reason', {
      type: Sequelize.STRING(1024),
      allowNull: true,
      after: 'status',
    });
    await queryInterface.addColumn('ExternalCampaignAssignments', 'archived_by_user_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      after: 'archive_reason',
    });
    await queryInterface.addColumn('ExternalCampaignAssignments', 'archived_at', {
      type: Sequelize.DATE,
      allowNull: true,
      after: 'archived_by_user_id',
    });
    await queryInterface.addIndex('ExternalCampaignAssignments', ['status', 'archived_at'], {
      name: 'idx_external_campaign_assignment_archive_audit',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      'ExternalCampaignAssignments',
      'idx_external_campaign_assignment_archive_audit'
    );
    await queryInterface.removeColumn('ExternalCampaignAssignments', 'archived_at');
    await queryInterface.removeColumn('ExternalCampaignAssignments', 'archived_by_user_id');
    await queryInterface.removeColumn('ExternalCampaignAssignments', 'archive_reason');
  },
};
