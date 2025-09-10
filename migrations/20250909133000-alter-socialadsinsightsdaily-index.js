/**
 * Migration: Alter unique index on SocialAdsInsightsDaily to include platform_position
 * - Old unique index: uniq_ads_insights_entity_date  (level, entity_id, date)
 * - New unique index: uniq_ads_insights_entity_date_platform_position (level, entity_id, date, publisher_platform, platform_position)
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    // Remove old unique index if it exists
    try {
      await queryInterface.removeIndex('SocialAdsInsightsDaily', 'uniq_ads_insights_entity_date');
    } catch (e) {
      // ignore if it didn't exist
    }

    // Add new unique index including platform_position and publisher_platform
    await queryInterface.addIndex('SocialAdsInsightsDaily', [
      'level',
      'entity_id',
      'date',
      'publisher_platform',
      'platform_position'
    ], {
      unique: true,
      name: 'uniq_ads_insights_entity_date_platform_position'
    });
  },

  async down(queryInterface, Sequelize) {
    // Revert to old unique index
    try {
      await queryInterface.removeIndex('SocialAdsInsightsDaily', 'uniq_ads_insights_entity_date_platform_position');
    } catch (e) {}

    await queryInterface.addIndex('SocialAdsInsightsDaily', [
      'level',
      'entity_id',
      'date'
    ], {
      unique: true,
      name: 'uniq_ads_insights_entity_date'
    });
  }
};

