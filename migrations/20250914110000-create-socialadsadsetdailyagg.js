"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('SocialAdsAdsetDailyAgg', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      ad_account_id: { type: Sequelize.STRING(64), allowNull: false },
      adset_id: { type: Sequelize.STRING(64), allowNull: false },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      spend: { type: Sequelize.DECIMAL(12,2), defaultValue: 0 },
      impressions: { type: Sequelize.INTEGER, defaultValue: 0 },
      clicks: { type: Sequelize.INTEGER, defaultValue: 0 },
      leads: { type: Sequelize.INTEGER, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('SocialAdsAdsetDailyAgg', ['ad_account_id','adset_id','date'], { unique: true, name: 'uniq_ads_adset_day' });
    await queryInterface.addIndex('SocialAdsAdsetDailyAgg', ['date'], { name: 'idx_ads_adset_day_date' });
  },
  async down(queryInterface) {
    await queryInterface.dropTable('SocialAdsAdsetDailyAgg');
  }
};
