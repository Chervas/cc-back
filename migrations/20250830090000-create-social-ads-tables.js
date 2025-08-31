'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // SocialAdsEntities: jerarquía y metadatos
    await queryInterface.createTable('SocialAdsEntities', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      ad_account_id: { type: Sequelize.STRING(64), allowNull: false },
      level: { type: Sequelize.ENUM('campaign', 'adset', 'ad'), allowNull: false },
      entity_id: { type: Sequelize.STRING(64), allowNull: false },
      parent_id: { type: Sequelize.STRING(64), allowNull: true },
      name: { type: Sequelize.STRING(255), allowNull: true },
      status: { type: Sequelize.STRING(64), allowNull: true },
      effective_status: { type: Sequelize.STRING(64), allowNull: true },
      objective: { type: Sequelize.STRING(128), allowNull: true },
      buying_type: { type: Sequelize.STRING(64), allowNull: true },
      created_time: { type: Sequelize.DATE, allowNull: true },
      updated_time: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('SocialAdsEntities', ['ad_account_id']);
    await queryInterface.addIndex('SocialAdsEntities', ['level', 'entity_id'], { unique: true, name: 'uniq_ads_level_entity' });

    // SocialAdsInsightsDaily: métricas por día
    await queryInterface.createTable('SocialAdsInsightsDaily', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      ad_account_id: { type: Sequelize.STRING(64), allowNull: false },
      level: { type: Sequelize.ENUM('campaign', 'adset', 'ad'), allowNull: false },
      entity_id: { type: Sequelize.STRING(64), allowNull: false },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      publisher_platform: { type: Sequelize.STRING(64), allowNull: true },
      platform_position: { type: Sequelize.STRING(64), allowNull: true },
      impressions: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      reach: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      clicks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      inline_link_clicks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      spend: { type: Sequelize.DECIMAL(12,2), allowNull: false, defaultValue: 0 },
      cpm: { type: Sequelize.DECIMAL(12,4), allowNull: false, defaultValue: 0 },
      cpc: { type: Sequelize.DECIMAL(12,4), allowNull: false, defaultValue: 0 },
      ctr: { type: Sequelize.DECIMAL(6,4), allowNull: false, defaultValue: 0 },
      frequency: { type: Sequelize.DECIMAL(6,3), allowNull: false, defaultValue: 0 },
      video_plays: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      video_plays_75: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('SocialAdsInsightsDaily', ['level', 'entity_id', 'date'], { unique: true, name: 'uniq_ads_insights_entity_date' });
    await queryInterface.addIndex('SocialAdsInsightsDaily', ['ad_account_id', 'date']);

    // SocialAdsActionsDaily: acciones desglosadas por día
    await queryInterface.createTable('SocialAdsActionsDaily', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      ad_account_id: { type: Sequelize.STRING(64), allowNull: false },
      level: { type: Sequelize.ENUM('campaign', 'adset', 'ad'), allowNull: false },
      entity_id: { type: Sequelize.STRING(64), allowNull: false },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      action_type: { type: Sequelize.STRING(128), allowNull: false },
      action_destination: { type: Sequelize.STRING(128), allowNull: true },
      value: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('SocialAdsActionsDaily', ['entity_id', 'date', 'action_type'], { name: 'idx_ads_actions_entity_date_type' });

    // PostPromotions: vínculo post orgánico ↔ anuncio
    await queryInterface.createTable('PostPromotions', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      asset_type: { type: Sequelize.ENUM('facebook_page', 'instagram_business'), allowNull: false },
      post_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'SocialPosts', key: 'id' } },
      ad_account_id: { type: Sequelize.STRING(64), allowNull: true },
      campaign_id: { type: Sequelize.STRING(64), allowNull: true },
      adset_id: { type: Sequelize.STRING(64), allowNull: true },
      ad_id: { type: Sequelize.STRING(64), allowNull: true },
      ad_creative_id: { type: Sequelize.STRING(64), allowNull: true },
      effective_instagram_media_id: { type: Sequelize.STRING(64), allowNull: true },
      effective_object_story_id: { type: Sequelize.STRING(64), allowNull: true },
      instagram_permalink_url: { type: Sequelize.STRING(512), allowNull: true },
      promo_start: { type: Sequelize.DATE, allowNull: true },
      promo_end: { type: Sequelize.DATE, allowNull: true },
      status: { type: Sequelize.STRING(64), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('PostPromotions', ['post_id']);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('PostPromotions');
    await queryInterface.dropTable('SocialAdsActionsDaily');
    await queryInterface.dropTable('SocialAdsInsightsDaily');
    await queryInterface.dropTable('SocialAdsEntities');
  }
};

