'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ManagedCampaignSpendSnapshot extends Model {}

  ManagedCampaignSpendSnapshot.init({
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    managed_campaign_id: { type: DataTypes.STRING(36), allowNull: false },
    provider: { type: DataTypes.ENUM('google_ads', 'meta_ads'), allowNull: false },
    customer_id: { type: DataTypes.STRING(64), allowNull: false },
    platform_campaign_id: { type: DataTypes.STRING(128), allowNull: false },
    spend_date: { type: DataTypes.DATEONLY, allowNull: false },
    spend_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EUR' },
    source: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'provider_sync' },
    captured_at: { type: DataTypes.DATE, allowNull: false },
  }, {
    sequelize,
    modelName: 'ManagedCampaignSpendSnapshot',
    tableName: 'ManagedCampaignSpendSnapshots',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
  });

  return ManagedCampaignSpendSnapshot;
};
