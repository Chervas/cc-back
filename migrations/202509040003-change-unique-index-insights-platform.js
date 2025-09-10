'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Drop old unique if exists
    try {
      await queryInterface.removeIndex('SocialAdsInsightsDaily', 'uniq_ads_insights_entity_date');
    } catch (_) {}

    // Add new unique with publisher_platform
    await queryInterface.addIndex('SocialAdsInsightsDaily', {
      name: 'uniq_ads_insights_entity_date_platform',
      unique: true,
      fields: ['level', 'entity_id', 'date', 'publisher_platform']
    });
  },
  async down(queryInterface, Sequelize) {
    try {
      await queryInterface.removeIndex('SocialAdsInsightsDaily', 'uniq_ads_insights_entity_date_platform');
    } catch (_) {}
    await queryInterface.addIndex('SocialAdsInsightsDaily', {
      name: 'uniq_ads_insights_entity_date',
      unique: true,
      fields: ['level', 'entity_id', 'date']
    });
  }
};

