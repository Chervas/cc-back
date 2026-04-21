'use strict';

module.exports = (sequelize, DataTypes) => {
  const MarketingCompetitorAdSnapshot = sequelize.define('MarketingCompetitorAdSnapshot', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    competitor_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    snapshot_date: { type: DataTypes.DATEONLY, allowNull: false },
    provider: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'meta_ads_library' },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pending' },
    ads_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    active_ads: { type: DataTypes.JSON, allowNull: true },
    error_code: { type: DataTypes.STRING(128), allowNull: true },
    error_message: { type: DataTypes.TEXT, allowNull: true },
    raw_payload: { type: DataTypes.JSON, allowNull: true }
  }, {
    tableName: 'MarketingCompetitorAdSnapshots',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['competitor_id', 'provider', 'snapshot_date'], name: 'uniq_competitor_ad_snapshot_day' },
      { fields: ['snapshot_date'] },
      { fields: ['provider', 'status'] }
    ]
  });

  MarketingCompetitorAdSnapshot.associate = function(models) {
    MarketingCompetitorAdSnapshot.belongsTo(models.MarketingCompetitor, { foreignKey: 'competitor_id', as: 'competitor' });
  };

  return MarketingCompetitorAdSnapshot;
};
