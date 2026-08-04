'use strict';

module.exports = (sequelize, DataTypes) => {
  const MarketingCompetitionHeatmapSearch = sequelize.define('MarketingCompetitionHeatmapSearch', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    primary_clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    search_term: { type: DataTypes.STRING(240), allowNull: false },
    normalized_term: { type: DataTypes.STRING(240), allowNull: false },
    effective_term: { type: DataTypes.STRING(512), allowNull: false },
    zoom_km: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 1 },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
    last_used_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    tableName: 'MarketingCompetitionHeatmapSearches',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['primary_clinic_id', 'normalized_term', 'zoom_km'], name: 'uniq_marketing_heatmap_saved_search' },
      { fields: ['primary_clinic_id', 'last_used_at'], name: 'idx_marketing_heatmap_saved_search_used' },
    ],
  });

  MarketingCompetitionHeatmapSearch.associate = function(models) {
    MarketingCompetitionHeatmapSearch.belongsTo(models.Clinica, {
      foreignKey: 'primary_clinic_id',
      targetKey: 'id_clinica',
      as: 'primaryClinic',
    });
    if (models.Usuario) {
      MarketingCompetitionHeatmapSearch.belongsTo(models.Usuario, {
        foreignKey: 'created_by',
        targetKey: 'id_usuario',
        as: 'creator',
      });
    }
  };

  return MarketingCompetitionHeatmapSearch;
};
