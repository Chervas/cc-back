module.exports = (sequelize, DataTypes) => {
  const SocialAdsAdsetDailyAgg = sequelize.define('SocialAdsAdsetDailyAgg', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ad_account_id: { type: DataTypes.STRING(64), allowNull: false },
    adset_id: { type: DataTypes.STRING(64), allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    spend: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    impressions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    leads: { type: DataTypes.DECIMAL(12, 4), allowNull: false, defaultValue: 0 }
  }, {
    tableName: 'SocialAdsAdsetDailyAgg',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['ad_account_id','adset_id','date'], name: 'uniq_ads_adset_day' },
      { fields: ['date'], name: 'idx_ads_adset_day_date' }
    ]
  });
  return SocialAdsAdsetDailyAgg;
};
