'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('GoogleAdsInsightsDaily', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      clinicGoogleAdsAccountId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'ClinicGoogleAdsAccounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      clinicaId: { type: Sequelize.INTEGER, allowNull: false },
      customerId: { type: Sequelize.STRING(32), allowNull: false },
      campaignId: { type: Sequelize.STRING(64), allowNull: false },
      campaignName: { type: Sequelize.STRING(256), allowNull: true },
      campaignStatus: { type: Sequelize.STRING(32), allowNull: true },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      network: { type: Sequelize.STRING(64), allowNull: true },
      device: { type: Sequelize.STRING(64), allowNull: true },
      impressions: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      clicks: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      costMicros: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      conversions: { type: Sequelize.DECIMAL(18,6), allowNull: false, defaultValue: 0 },
      conversionsValue: { type: Sequelize.DECIMAL(18,6), allowNull: false, defaultValue: 0 },
      ctr: { type: Sequelize.DECIMAL(10,6), allowNull: false, defaultValue: 0 },
      averageCpcMicros: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      averageCpmMicros: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      averageCostMicros: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      conversionsFromInteractionsRate: { type: Sequelize.DECIMAL(10,6), allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });

    await queryInterface.addIndex('GoogleAdsInsightsDaily', ['clinicGoogleAdsAccountId', 'date'], {
      name: 'idx_google_ads_account_date'
    });
    await queryInterface.addIndex('GoogleAdsInsightsDaily', ['clinicaId', 'date'], {
      name: 'idx_google_ads_clinica_date'
    });
    await queryInterface.addConstraint('GoogleAdsInsightsDaily', {
      fields: ['campaignId', 'date', 'clinicGoogleAdsAccountId', 'network', 'device'],
      type: 'unique',
      name: 'uniq_google_ads_campaign_date_account'
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('GoogleAdsInsightsDaily');
  }
};
