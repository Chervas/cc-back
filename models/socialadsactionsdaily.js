// models/SocialAdsActionsDaily.js
module.exports = (sequelize, DataTypes) => {
  const SocialAdsActionsDaily = sequelize.define('SocialAdsActionsDaily', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    ad_account_id: { type: DataTypes.STRING(64), allowNull: false },
    level: { type: DataTypes.ENUM('campaign', 'adset', 'ad'), allowNull: false },
    entity_id: { type: DataTypes.STRING(64), allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    action_type: { type: DataTypes.STRING(128), allowNull: false },
    action_destination: { type: DataTypes.STRING(128) },
    publisher_platform: { type: DataTypes.STRING(64), allowNull: true },
    value: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: 'SocialAdsActionsDaily',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['entity_id', 'date', 'action_type'], name: 'idx_ads_actions_entity_date_type' },
      { fields: ['ad_account_id','date','entity_id','action_type','publisher_platform'], name: 'idx_actions_acc_date_entity_type_plat' }
    ]
  });

  SocialAdsActionsDaily.associate = function(models) {
    SocialAdsActionsDaily.belongsTo(models.SocialAdsEntity, { foreignKey: 'entity_id', targetKey: 'entity_id', as: 'entity' });
  };

  return SocialAdsActionsDaily;
};
