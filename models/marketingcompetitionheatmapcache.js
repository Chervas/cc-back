'use strict';

module.exports = (sequelize, DataTypes) => {
  const MarketingCompetitionHeatmapCache = sequelize.define('MarketingCompetitionHeatmapCache', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    cache_key: { type: DataTypes.STRING(64), allowNull: false },
    algorithm_version: { type: DataTypes.STRING(96), allowNull: false },
    scope_key: { type: DataTypes.STRING(64), allowNull: false },
    scope_type: { type: DataTypes.STRING(32), allowNull: true },
    scope_payload: { type: DataTypes.JSON, allowNull: false },
    primary_clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    place_key: { type: DataTypes.STRING(512), allowNull: false },
    google_place_id: { type: DataTypes.STRING(255), allowNull: true },
    search_term: { type: DataTypes.STRING(512), allowNull: false },
    zoom_km: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    grid_size: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: true },
    provider_requests: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    generated_at: { type: DataTypes.DATE, allowNull: true },
    fresh_until: { type: DataTypes.DATE, allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    refresh_state: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'idle' },
    refresh_lock_token: { type: DataTypes.STRING(64), allowNull: true },
    refresh_locked_until: { type: DataTypes.DATE, allowNull: true },
    last_refresh_started_at: { type: DataTypes.DATE, allowNull: true },
    last_refresh_finished_at: { type: DataTypes.DATE, allowNull: true },
    last_refresh_error: { type: DataTypes.TEXT, allowNull: true }
  }, {
    tableName: 'MarketingCompetitionHeatmapCaches',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['cache_key'], name: 'uniq_marketing_heatmap_cache_key' },
      { fields: ['primary_clinic_id', 'algorithm_version'], name: 'idx_marketing_heatmap_clinic_algorithm' },
      { fields: ['expires_at'], name: 'idx_marketing_heatmap_expires' },
      { fields: ['refresh_locked_until'], name: 'idx_marketing_heatmap_refresh_lease' }
    ]
  });

  MarketingCompetitionHeatmapCache.associate = function(models) {
    MarketingCompetitionHeatmapCache.belongsTo(models.Clinica, {
      foreignKey: 'primary_clinic_id',
      targetKey: 'id_clinica',
      as: 'primaryClinic'
    });
  };

  return MarketingCompetitionHeatmapCache;
};
