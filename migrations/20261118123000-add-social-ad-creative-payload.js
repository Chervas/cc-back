'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const columns = await queryInterface.describeTable('SocialAdsEntities');
    if (!columns.creative_payload) await queryInterface.addColumn('SocialAdsEntities', 'creative_payload', {
      type: Sequelize.JSON,
      allowNull: true,
      comment: 'Versioned exact-ad creative recovered by the normal authorized AdsSync reader',
    });
  },
  async down() {
    throw new Error('social_ad_creative_preserved_rollback_code_only');
  },
};
