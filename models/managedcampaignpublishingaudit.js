'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ManagedCampaignPublishingAudit extends Model {
    static associate(models) {
      if (models.ManagedCampaign) {
        ManagedCampaignPublishingAudit.belongsTo(models.ManagedCampaign, {
          foreignKey: 'managed_campaign_id',
          as: 'campaign',
        });
      }
    }
  }

  ManagedCampaignPublishingAudit.init({
    id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
    managed_campaign_id: { type: DataTypes.STRING(36), allowNull: false },
    plan_id: { type: DataTypes.STRING(191), allowNull: false },
    plan_hash: { type: DataTypes.STRING(64), allowNull: false },
    campaign_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    provider: { type: DataTypes.STRING(32), allowNull: false },
    family: { type: DataTypes.STRING(64), allowNull: false },
    mode: { type: DataTypes.ENUM('dry_run'), allowNull: false, defaultValue: 'dry_run' },
    readiness_status: { type: DataTypes.ENUM('ready', 'blocked'), allowNull: false },
    blocker_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    warning_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    gate_evidence: { type: DataTypes.JSON, allowNull: false },
    plan_snapshot: { type: DataTypes.JSON, allowNull: false },
    idempotency_key: { type: DataTypes.STRING(191), allowNull: false },
    requested_by_user_id: { type: DataTypes.INTEGER, allowNull: false },
    provider_call_performed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, {
    sequelize,
    modelName: 'ManagedCampaignPublishingAudit',
    tableName: 'ManagedCampaignPublishingAudits',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
    indexes: [
      { unique: true, fields: ['managed_campaign_id', 'idempotency_key'] },
      { fields: ['managed_campaign_id', 'created_at'] },
      { fields: ['plan_hash'] },
    ],
  });

  return ManagedCampaignPublishingAudit;
};
