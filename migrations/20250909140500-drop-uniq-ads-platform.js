/**
 * Migration: Drop legacy unique index uniq_ads_insights_entity_date_platform
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.removeIndex('SocialAdsInsightsDaily', 'uniq_ads_insights_entity_date_platform');
    } catch (e) {
      // ignore if not exists
    }
  },

  async down(queryInterface, Sequelize) {
    // Recreate the legacy index (not recommended, but provided for completeness)
    await queryInterface.addIndex('SocialAdsInsightsDaily', [
      'level', 'entity_id', 'date', 'publisher_platform'
    ], {
      unique: true,
      name: 'uniq_ads_insights_entity_date_platform'
    });
  }
};

