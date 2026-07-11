'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ManagedCampaign extends Model {
    static associate(models) {
      if (models.Clinica) {
        ManagedCampaign.belongsTo(models.Clinica, {
          foreignKey: 'clinica_id',
          targetKey: 'id_clinica',
          as: 'clinic',
        });
      }
      if (models.ManagedCampaignFundingAccount) {
        ManagedCampaign.hasOne(models.ManagedCampaignFundingAccount, {
          foreignKey: 'managed_campaign_id',
          as: 'funding',
        });
      }
      if (models.ManagedCampaignSpendSnapshot) {
        ManagedCampaign.hasMany(models.ManagedCampaignSpendSnapshot, {
          foreignKey: 'managed_campaign_id',
          as: 'spend_snapshots',
        });
      }
    }
  }

  ManagedCampaign.init({
    id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
    strategy_campaign_id: DataTypes.INTEGER,
    campaign_request_id: DataTypes.INTEGER,
    objective_id: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'new_patients' },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    grupo_clinica_id: DataTypes.INTEGER,
    management_mode: { type: DataTypes.ENUM('connect_only', 'autopilot'), allowNull: false, defaultValue: 'autopilot' },
    legacy_mode: DataTypes.STRING(32),
    operation_mode: { type: DataTypes.ENUM('observe', 'managed'), allowNull: false, defaultValue: 'observe' },
    provider: { type: DataTypes.ENUM('google_ads', 'meta_ads'), allowNull: false },
    family: { type: DataTypes.ENUM('google_search', 'google_pmax', 'google_smart_observe', 'meta_reach', 'meta_instant_form'), allowNull: false },
    status: {
      type: DataTypes.ENUM('draft', 'pending_client_review', 'pending_admin_review', 'changes_requested', 'approved_to_launch', 'launching', 'active', 'paused', 'blocked', 'completed', 'cancelled'),
      allowNull: false,
      defaultValue: 'draft',
    },
    name: { type: DataTypes.STRING(255), allowNull: false },
    target_config: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    budget_config: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    schedule_config: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    destination_config: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    audience_config: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    creative_config: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    tracking_plan: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    platform_refs: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    review_config: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    policy_readiness: { type: DataTypes.JSON, allowNull: false, defaultValue: { status: 'warning', reasons: ['pending_review'] } },
    assigned_to_user_id: DataTypes.INTEGER,
    approved_by_user_id: DataTypes.INTEGER,
    approved_at: DataTypes.DATE,
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    created_by_user_id: DataTypes.INTEGER,
    updated_by_user_id: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'ManagedCampaign',
    tableName: 'ManagedCampaigns',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
  });

  return ManagedCampaign;
};
