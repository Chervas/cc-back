'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('MarketingCompetitors', {
      id: { type: Sequelize.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      grupo_clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      name: { type: Sequelize.STRING(255), allowNull: false },
      source: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'manual' },
      google_place_id: { type: Sequelize.STRING(255), allowNull: true },
      google_maps_url: { type: Sequelize.TEXT, allowNull: true },
      website_url: { type: Sequelize.TEXT, allowNull: true },
      phone: { type: Sequelize.STRING(80), allowNull: true },
      address: { type: Sequelize.TEXT, allowNull: true },
      city: { type: Sequelize.STRING(160), allowNull: true },
      latitude: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
      longitude: { type: Sequelize.DECIMAL(10, 7), allowNull: true },
      primary_category: { type: Sequelize.STRING(255), allowNull: true },
      rating: { type: Sequelize.DECIMAL(3, 2), allowNull: true },
      review_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      business_status: { type: Sequelize.STRING(80), allowNull: true },
      meta_page_id: { type: Sequelize.STRING(255), allowNull: true },
      meta_page_name: { type: Sequelize.STRING(255), allowNull: true },
      meta_page_url: { type: Sequelize.TEXT, allowNull: true },
      meta_ads_search_terms: { type: Sequelize.JSON, allowNull: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      last_places_synced_at: { type: Sequelize.DATE, allowNull: true },
      last_ads_synced_at: { type: Sequelize.DATE, allowNull: true },
      last_sync_status: { type: Sequelize.STRING(32), allowNull: true },
      last_sync_error: { type: Sequelize.TEXT, allowNull: true },
      raw_place_payload: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('MarketingCompetitors', ['clinica_id', 'is_active'], { name: 'idx_marketing_competitors_clinic_active' });
    await queryInterface.addIndex('MarketingCompetitors', ['grupo_clinica_id', 'is_active'], { name: 'idx_marketing_competitors_group_active' });
    await queryInterface.addIndex('MarketingCompetitors', ['google_place_id'], { name: 'idx_marketing_competitors_google_place' });
    await queryInterface.addIndex('MarketingCompetitors', ['meta_page_id'], { name: 'idx_marketing_competitors_meta_page' });

    await queryInterface.createTable('MarketingCompetitorSnapshots', {
      id: { type: Sequelize.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      competitor_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'MarketingCompetitors', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      snapshot_date: { type: Sequelize.DATEONLY, allowNull: false },
      rating: { type: Sequelize.DECIMAL(3, 2), allowNull: true },
      review_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      primary_category: { type: Sequelize.STRING(255), allowNull: true },
      website_url: { type: Sequelize.TEXT, allowNull: true },
      phone: { type: Sequelize.STRING(80), allowNull: true },
      address: { type: Sequelize.TEXT, allowNull: true },
      business_status: { type: Sequelize.STRING(80), allowNull: true },
      raw_payload: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('MarketingCompetitorSnapshots', ['competitor_id', 'snapshot_date'], { unique: true, name: 'uniq_competitor_snapshot_day' });
    await queryInterface.addIndex('MarketingCompetitorSnapshots', ['snapshot_date'], { name: 'idx_competitor_snapshots_date' });

    await queryInterface.createTable('MarketingCompetitorAdSnapshots', {
      id: { type: Sequelize.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      competitor_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'MarketingCompetitors', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      snapshot_date: { type: Sequelize.DATEONLY, allowNull: false },
      provider: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'meta_ads_library' },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'pending' },
      ads_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      active_ads: { type: Sequelize.JSON, allowNull: true },
      error_code: { type: Sequelize.STRING(128), allowNull: true },
      error_message: { type: Sequelize.TEXT, allowNull: true },
      raw_payload: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
    await queryInterface.addIndex('MarketingCompetitorAdSnapshots', ['competitor_id', 'provider', 'snapshot_date'], { unique: true, name: 'uniq_competitor_ad_snapshot_day' });
    await queryInterface.addIndex('MarketingCompetitorAdSnapshots', ['snapshot_date'], { name: 'idx_competitor_ad_snapshots_date' });
    await queryInterface.addIndex('MarketingCompetitorAdSnapshots', ['provider', 'status'], { name: 'idx_competitor_ad_snapshots_provider_status' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('MarketingCompetitorAdSnapshots');
    await queryInterface.dropTable('MarketingCompetitorSnapshots');
    await queryInterface.dropTable('MarketingCompetitors');
  }
};
