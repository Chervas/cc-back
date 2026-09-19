'use strict';

module.exports = (sequelize, DataTypes) => sequelize.define('GoogleAdsAdInventory', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  clinicGoogleAdsAccountId: { type: DataTypes.INTEGER, allowNull: false },
  customerId: { type: DataTypes.STRING(32), allowNull: false },
  campaignId: { type: DataTypes.STRING(64), allowNull: false },
  campaignName: DataTypes.STRING(256),
  campaignStatus: DataTypes.STRING(32),
  adGroupId: { type: DataTypes.STRING(64), allowNull: false },
  adGroupName: DataTypes.STRING(256),
  adGroupStatus: DataTypes.STRING(32),
  adId: { type: DataTypes.STRING(64), allowNull: false },
  adName: DataTypes.STRING(256),
  adType: DataTypes.STRING(64),
  adStatus: DataTypes.STRING(32),
  deliveryObservation: DataTypes.JSON,
  finalUrl: DataTypes.STRING(1024),
  displayUrl: DataTypes.STRING(512),
  headlines: DataTypes.JSON,
  descriptions: DataTypes.JSON,
  present: { type: DataTypes.BOOLEAN, allowNull: false },
  observedAt: { type: DataTypes.DATE(3), allowNull: false },
}, {
  tableName: 'GoogleAdsAdInventory', createdAt: 'created_at', updatedAt: 'updated_at',
  indexes: [
    { name: 'uniq_google_ad_inventory_identity', unique: true, fields: ['clinicGoogleAdsAccountId', 'campaignId', 'adGroupId', 'adId'] },
    { name: 'idx_google_ad_inventory_campaign', fields: ['customerId', 'campaignId'] },
  ],
});
