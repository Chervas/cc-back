'use strict';

module.exports = (sequelize, DataTypes) => {
  const MarketingCompetitor = sequelize.define('MarketingCompetitor', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    grupo_clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    source: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'manual' },
    google_place_id: { type: DataTypes.STRING(255), allowNull: true },
    google_maps_url: { type: DataTypes.TEXT, allowNull: true },
    website_url: { type: DataTypes.TEXT, allowNull: true },
    phone: { type: DataTypes.STRING(80), allowNull: true },
    address: { type: DataTypes.TEXT, allowNull: true },
    city: { type: DataTypes.STRING(160), allowNull: true },
    latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: true },
    primary_category: { type: DataTypes.STRING(255), allowNull: true },
    rating: { type: DataTypes.DECIMAL(3, 2), allowNull: true },
    review_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    business_status: { type: DataTypes.STRING(80), allowNull: true },
    meta_page_id: { type: DataTypes.STRING(255), allowNull: true },
    meta_page_name: { type: DataTypes.STRING(255), allowNull: true },
    meta_page_url: { type: DataTypes.TEXT, allowNull: true },
    meta_ads_search_terms: { type: DataTypes.JSON, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    last_places_synced_at: { type: DataTypes.DATE, allowNull: true },
    last_ads_synced_at: { type: DataTypes.DATE, allowNull: true },
    last_sync_status: { type: DataTypes.STRING(32), allowNull: true },
    last_sync_error: { type: DataTypes.TEXT, allowNull: true },
    raw_place_payload: { type: DataTypes.JSON, allowNull: true }
  }, {
    tableName: 'MarketingCompetitors',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['clinica_id', 'is_active'] },
      { fields: ['grupo_clinica_id', 'is_active'] },
      { fields: ['google_place_id'] },
      { fields: ['meta_page_id'] }
    ]
  });

  MarketingCompetitor.associate = function(models) {
    MarketingCompetitor.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
    MarketingCompetitor.belongsTo(models.GrupoClinica, { foreignKey: 'grupo_clinica_id', targetKey: 'id_grupo', as: 'grupoClinica' });
    MarketingCompetitor.hasMany(models.MarketingCompetitorSnapshot, { foreignKey: 'competitor_id', as: 'snapshots' });
    MarketingCompetitor.hasMany(models.MarketingCompetitorAdSnapshot, { foreignKey: 'competitor_id', as: 'adSnapshots' });
  };

  return MarketingCompetitor;
};
