'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('MarketingCompetitionHeatmapCaches', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      cache_key: { type: Sequelize.STRING(64), allowNull: false },
      algorithm_version: { type: Sequelize.STRING(96), allowNull: false },
      scope_key: { type: Sequelize.STRING(64), allowNull: false },
      scope_type: { type: Sequelize.STRING(32), allowNull: true },
      scope_payload: { type: Sequelize.JSON, allowNull: false },
      primary_clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      place_key: { type: Sequelize.STRING(512), allowNull: false },
      google_place_id: { type: Sequelize.STRING(255), allowNull: true },
      search_term: { type: Sequelize.STRING(512), allowNull: false },
      zoom_km: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false },
      grid_size: { type: Sequelize.TINYINT.UNSIGNED, allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: true },
      provider_requests: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      generated_at: { type: Sequelize.DATE, allowNull: true },
      fresh_until: { type: Sequelize.DATE, allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      refresh_state: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'idle' },
      refresh_lock_token: { type: Sequelize.STRING(64), allowNull: true },
      refresh_locked_until: { type: Sequelize.DATE, allowNull: true },
      last_refresh_started_at: { type: Sequelize.DATE, allowNull: true },
      last_refresh_finished_at: { type: Sequelize.DATE, allowNull: true },
      last_refresh_error: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('MarketingCompetitionHeatmapCaches', ['cache_key'], {
      unique: true,
      name: 'uniq_marketing_heatmap_cache_key'
    });
    await queryInterface.addIndex('MarketingCompetitionHeatmapCaches', ['primary_clinic_id', 'algorithm_version'], {
      name: 'idx_marketing_heatmap_clinic_algorithm'
    });
    await queryInterface.addIndex('MarketingCompetitionHeatmapCaches', ['expires_at'], {
      name: 'idx_marketing_heatmap_expires'
    });
    await queryInterface.addIndex('MarketingCompetitionHeatmapCaches', ['refresh_locked_until'], {
      name: 'idx_marketing_heatmap_refresh_lease'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('MarketingCompetitionHeatmapCaches');
  }
};
