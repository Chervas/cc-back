// models/SocialAdsEntity.js
module.exports = (sequelize, DataTypes) => {
  const SocialAdsEntity = sequelize.define('SocialAdsEntity', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ad_account_id: { type: DataTypes.STRING(64), allowNull: false },
    level: { type: DataTypes.ENUM('campaign', 'adset', 'ad'), allowNull: false },
    entity_id: { type: DataTypes.STRING(64), allowNull: false },
    parent_id: { type: DataTypes.STRING(64) },
    name: { type: DataTypes.STRING(255) },
    status: { type: DataTypes.STRING(64) },
    effective_status: { type: DataTypes.STRING(64) },
    objective: { type: DataTypes.STRING(128) },
    buying_type: { type: DataTypes.STRING(64) },
    created_time: { type: DataTypes.DATE },
    updated_time: { type: DataTypes.DATE }
    ,delivery_reason_text: { type: DataTypes.TEXT, allowNull: true }
    ,delivery_status: { type: DataTypes.STRING(64), allowNull: true }
    ,delivery_checked_at: { type: DataTypes.DATE, allowNull: true }
    ,peak_frequency: { type: DataTypes.DECIMAL(10,3), allowNull: true }
    ,peak_frequency_date: { type: DataTypes.DATEONLY, allowNull: true }
  }, {
    tableName: 'SocialAdsEntities',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['ad_account_id'] },
      { unique: true, fields: ['level', 'entity_id'], name: 'uniq_ads_level_entity' }
    ]
  });

  SocialAdsEntity.associate = function(models) {
    // Relaciones opcionales: un entity puede tener muchos insights y muchas actions
    SocialAdsEntity.hasMany(models.SocialAdsInsightsDaily, { foreignKey: 'entity_id', sourceKey: 'entity_id', as: 'insights' });
    SocialAdsEntity.hasMany(models.SocialAdsActionsDaily, { foreignKey: 'entity_id', sourceKey: 'entity_id', as: 'actions' });
  };

  return SocialAdsEntity;
};
