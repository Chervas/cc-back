'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('GoogleAdsAdInsightsDaily', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      clinicGoogleAdsAccountId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'ClinicGoogleAdsAccounts', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      clinicaId: { type: Sequelize.INTEGER, allowNull: true },
      grupoClinicaId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      customerId: { type: Sequelize.STRING(32), allowNull: false },
      campaignId: { type: Sequelize.STRING(64), allowNull: false },
      campaignName: { type: Sequelize.STRING(256), allowNull: true },
      campaignStatus: { type: Sequelize.STRING(32), allowNull: true },
      adGroupId: { type: Sequelize.STRING(64), allowNull: true },
      adGroupName: { type: Sequelize.STRING(256), allowNull: true },
      adId: { type: Sequelize.STRING(64), allowNull: false },
      adName: { type: Sequelize.STRING(256), allowNull: true },
      adType: { type: Sequelize.STRING(64), allowNull: true },
      adStatus: { type: Sequelize.STRING(32), allowNull: true },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      network: { type: Sequelize.STRING(64), allowNull: false, defaultValue: '' },
      device: { type: Sequelize.STRING(64), allowNull: false, defaultValue: '' },
      impressions: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      clicks: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      costMicros: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      conversions: { type: Sequelize.DECIMAL(18, 6), allowNull: false, defaultValue: 0 },
      ctr: { type: Sequelize.DECIMAL(10, 6), allowNull: false, defaultValue: 0 },
      finalUrl: { type: Sequelize.STRING(1024), allowNull: true },
      displayUrl: { type: Sequelize.STRING(512), allowNull: true },
      headlines: { type: Sequelize.JSON, allowNull: true },
      descriptions: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });

    await queryInterface.addIndex('GoogleAdsAdInsightsDaily', ['clinicGoogleAdsAccountId', 'date', 'adId', 'network', 'device'], {
      name: 'uniq_google_ads_ad_date_account',
      unique: true
    });
    await queryInterface.addIndex('GoogleAdsAdInsightsDaily', ['campaignId', 'date'], {
      name: 'idx_google_ads_ad_campaign_date'
    });
    await queryInterface.addIndex('GoogleAdsAdInsightsDaily', ['clinicaId', 'date'], {
      name: 'idx_google_ads_ad_clinic_date'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('GoogleAdsAdInsightsDaily');
  }
};
