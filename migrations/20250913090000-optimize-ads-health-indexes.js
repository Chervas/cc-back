"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    try {
      await queryInterface.addIndex('SocialAdsInsightsDaily', ['ad_account_id','level','date','entity_id'], {
        name: 'idx_insights_acc_level_date_entity'
      });
    } catch {}
    try {
      await queryInterface.addIndex('SocialAdsEntities', ['parent_id'], {
        name: 'idx_entities_parent'
      });
    } catch {}
    try {
      await queryInterface.addIndex('SocialAdsEntities', ['level','parent_id'], {
        name: 'idx_entities_level_parent'
      });
    } catch {}
  },
  async down(queryInterface, Sequelize) {
    try { await queryInterface.removeIndex('SocialAdsInsightsDaily', 'idx_insights_acc_level_date_entity'); } catch {}
    try { await queryInterface.removeIndex('SocialAdsEntities', 'idx_entities_parent'); } catch {}
    try { await queryInterface.removeIndex('SocialAdsEntities', 'idx_entities_level_parent'); } catch {}
  }
};

