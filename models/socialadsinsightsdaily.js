// models/SocialAdsInsightsDaily.js
module.exports = (sequelize, DataTypes) => {
  const SocialAdsInsightsDaily = sequelize.define('SocialAdsInsightsDaily', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ad_account_id: { type: DataTypes.STRING(64), allowNull: false },
    level: { type: DataTypes.ENUM('campaign', 'adset', 'ad'), allowNull: false },
    entity_id: { type: DataTypes.STRING(64), allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    publisher_platform: { type: DataTypes.STRING(64) },
    platform_position: { type: DataTypes.STRING(64) },
    impressions: { type: DataTypes.INTEGER, defaultValue: 0 },
    reach: { type: DataTypes.INTEGER, defaultValue: 0 },
    clicks: { type: DataTypes.INTEGER, defaultValue: 0 },
    inline_link_clicks: { type: DataTypes.INTEGER, defaultValue: 0 },
    spend: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
    cpm: { type: DataTypes.DECIMAL(12,4), defaultValue: 0 },
    cpc: { type: DataTypes.DECIMAL(12,4), defaultValue: 0 },
    ctr: { type: DataTypes.DECIMAL(6,4), defaultValue: 0 },
    frequency: { type: DataTypes.DECIMAL(6,3), defaultValue: 0 },
    video_plays: { type: DataTypes.INTEGER, defaultValue: 0 },
    video_plays_75: { type: DataTypes.INTEGER, defaultValue: 0 }
  }, {
    tableName: 'SocialAdsInsightsDaily',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      {
        unique: true,
        fields: ['level', 'entity_id', 'date', 'publisher_platform', 'platform_position'],
        name: 'uniq_ads_insights_entity_date_platform_position'
      },
      { fields: ['ad_account_id', 'date'] }
    ]
  });

  SocialAdsInsightsDaily.associate = function(models) {
    SocialAdsInsightsDaily.belongsTo(models.SocialAdsEntity, { foreignKey: 'entity_id', targetKey: 'entity_id', as: 'entity' });
  };

  return SocialAdsInsightsDaily;
};
