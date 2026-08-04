'use strict';

module.exports = (sequelize, DataTypes) => {
  const MarketingCompetitionHeatmapSnapshot = sequelize.define('MarketingCompetitionHeatmapSnapshot', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    cache_key: { type: DataTypes.STRING(64), allowNull: false },
    primary_clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    search_term: { type: DataTypes.STRING(512), allowNull: false },
    zoom_km: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    grid_size: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
    algorithm_version: { type: DataTypes.STRING(96), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    generated_at: { type: DataTypes.DATE, allowNull: false },
  }, {
    tableName: 'MarketingCompetitionHeatmapSnapshots',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
      { unique: true, fields: ['cache_key', 'generated_at'], name: 'uniq_marketing_heatmap_snapshot_generated' },
      { fields: ['primary_clinic_id', 'search_term', 'zoom_km', 'generated_at'], name: 'idx_marketing_heatmap_snapshot_history' },
      { fields: ['generated_at'], name: 'idx_marketing_heatmap_snapshot_retention' },
    ],
  });

  MarketingCompetitionHeatmapSnapshot.associate = function(models) {
    MarketingCompetitionHeatmapSnapshot.belongsTo(models.Clinica, {
      foreignKey: 'primary_clinic_id',
      targetKey: 'id_clinica',
      as: 'primaryClinic',
    });
  };

  return MarketingCompetitionHeatmapSnapshot;
};
