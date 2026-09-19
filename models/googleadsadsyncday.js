'use strict';

module.exports = (sequelize, DataTypes) => sequelize.define('GoogleAdsAdSyncDay', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  clinicGoogleAdsAccountId: { type: DataTypes.INTEGER, allowNull: false },
  customerId: { type: DataTypes.STRING(32), allowNull: false },
  // Empty campaignId denotes a complete account query, not a campaign with no ID.
  campaignId: { type: DataTypes.STRING(64), allowNull: false, defaultValue: '' },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  observedAt: { type: DataTypes.DATE(3), allowNull: false },
}, {
  tableName: 'GoogleAdsAdSyncDays', createdAt: 'created_at', updatedAt: 'updated_at',
  indexes: [
    { name: 'uniq_google_ad_sync_day', unique: true, fields: ['clinicGoogleAdsAccountId', 'campaignId', 'date'] },
    { name: 'idx_google_ad_sync_customer_date', fields: ['customerId', 'date'] },
  ],
});
