'use strict';

module.exports = (sequelize, DataTypes) => {
  const MarketingCompetitorSnapshot = sequelize.define('MarketingCompetitorSnapshot', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    competitor_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    snapshot_date: { type: DataTypes.DATEONLY, allowNull: false },
    rating: { type: DataTypes.DECIMAL(3, 2), allowNull: true },
    review_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    primary_category: { type: DataTypes.STRING(255), allowNull: true },
    website_url: { type: DataTypes.TEXT, allowNull: true },
    phone: { type: DataTypes.STRING(80), allowNull: true },
    address: { type: DataTypes.TEXT, allowNull: true },
    business_status: { type: DataTypes.STRING(80), allowNull: true },
    raw_payload: { type: DataTypes.JSON, allowNull: true }
  }, {
    tableName: 'MarketingCompetitorSnapshots',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['competitor_id', 'snapshot_date'], name: 'uniq_competitor_snapshot_day' },
      { fields: ['snapshot_date'] }
    ]
  });

  MarketingCompetitorSnapshot.associate = function(models) {
    MarketingCompetitorSnapshot.belongsTo(models.MarketingCompetitor, { foreignKey: 'competitor_id', as: 'competitor' });
  };

  return MarketingCompetitorSnapshot;
};
