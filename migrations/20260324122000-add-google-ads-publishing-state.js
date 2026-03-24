'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('ClinicGoogleAdsAccounts', 'publishingStatus', {
      type: Sequelize.STRING(128),
      allowNull: true,
      after: 'accountStatus',
    });
    await queryInterface.addColumn('ClinicGoogleAdsAccounts', 'publishingReason', {
      type: Sequelize.TEXT,
      allowNull: true,
      after: 'publishingStatus',
    });
    await queryInterface.addColumn('ClinicGoogleAdsAccounts', 'publishingReasons', {
      type: Sequelize.TEXT('long'),
      allowNull: true,
      after: 'publishingReason',
    });
    await queryInterface.addColumn('ClinicGoogleAdsAccounts', 'publishingCampaignId', {
      type: Sequelize.STRING(64),
      allowNull: true,
      after: 'publishingReasons',
    });
    await queryInterface.addColumn('ClinicGoogleAdsAccounts', 'publishingCampaignName', {
      type: Sequelize.STRING(256),
      allowNull: true,
      after: 'publishingCampaignId',
    });
    await queryInterface.addColumn('ClinicGoogleAdsAccounts', 'publishingSyncedAt', {
      type: Sequelize.DATE,
      allowNull: true,
      after: 'publishingCampaignName',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('ClinicGoogleAdsAccounts', 'publishingSyncedAt');
    await queryInterface.removeColumn('ClinicGoogleAdsAccounts', 'publishingCampaignName');
    await queryInterface.removeColumn('ClinicGoogleAdsAccounts', 'publishingCampaignId');
    await queryInterface.removeColumn('ClinicGoogleAdsAccounts', 'publishingReasons');
    await queryInterface.removeColumn('ClinicGoogleAdsAccounts', 'publishingReason');
    await queryInterface.removeColumn('ClinicGoogleAdsAccounts', 'publishingStatus');
  },
};
