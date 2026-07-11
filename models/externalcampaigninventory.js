'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ExternalCampaignInventory extends Model {
    static associate(models) {
      if (models.ExternalCampaignAssignment) {
        ExternalCampaignInventory.hasOne(models.ExternalCampaignAssignment, {
          foreignKey: 'inventory_id',
          as: 'assignment',
        });
      }
    }
  }

  ExternalCampaignInventory.init({
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    provider: { type: DataTypes.ENUM('google_ads', 'meta_ads'), allowNull: false },
    customer_id: { type: DataTypes.STRING(64), allowNull: false },
    account_name: DataTypes.STRING(255),
    campaign_id: { type: DataTypes.STRING(128), allowNull: false },
    campaign_name: DataTypes.STRING(512),
    status: DataTypes.STRING(64),
    channel_type: DataTypes.STRING(64),
    source: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'provider_sync' },
    latest_metrics: DataTypes.JSON,
    destination_detection: DataTypes.JSON,
    last_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'ExternalCampaignInventory',
    tableName: 'ExternalCampaignInventories',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
  });

  return ExternalCampaignInventory;
};
