'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ManagedCampaignProviderExecution extends Model {
    static associate(models) {
      if (models.ManagedCampaign) {
        ManagedCampaignProviderExecution.belongsTo(models.ManagedCampaign, {
          foreignKey: 'managed_campaign_id',
          as: 'campaign',
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        });
      }
      if (models.ManagedCampaignFundingAccount) {
        ManagedCampaignProviderExecution.belongsTo(models.ManagedCampaignFundingAccount, {
          foreignKey: 'funding_account_id',
          as: 'funding',
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        });
      }
      if (models.ManagedCampaignPublishingAudit) {
        ManagedCampaignProviderExecution.belongsTo(models.ManagedCampaignPublishingAudit, {
          foreignKey: 'source_publishing_audit_id',
          as: 'source_publishing_audit',
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        });
      }
      if (models.JobRequest) {
        ManagedCampaignProviderExecution.belongsTo(models.JobRequest, {
          foreignKey: 'job_request_id',
          as: 'job_request',
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        });
        ManagedCampaignProviderExecution.belongsTo(models.JobRequest, {
          foreignKey: 'activation_job_request_id',
          as: 'activation_job_request',
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        });
        ManagedCampaignProviderExecution.belongsTo(models.JobRequest, {
          foreignKey: 'rollback_job_request_id',
          as: 'rollback_job_request',
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        });
      }
      if (models.Usuario) {
        ManagedCampaignProviderExecution.belongsTo(models.Usuario, {
          foreignKey: 'requested_by_user_id',
          targetKey: 'id_usuario',
          as: 'requested_by',
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
        });
        ManagedCampaignProviderExecution.belongsTo(models.Usuario, {
          foreignKey: 'activation_requested_by_user_id',
          targetKey: 'id_usuario',
          as: 'activation_requested_by',
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        });
        ManagedCampaignProviderExecution.belongsTo(models.Usuario, {
          foreignKey: 'rollback_requested_by_user_id',
          targetKey: 'id_usuario',
          as: 'rollback_requested_by',
          onUpdate: 'CASCADE',
          onDelete: 'SET NULL',
        });
      }
    }
  }

  ManagedCampaignProviderExecution.init({
    id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
    managed_campaign_id: { type: DataTypes.STRING(36), allowNull: false },
    funding_account_id: { type: DataTypes.STRING(36), allowNull: false },
    source_publishing_audit_id: DataTypes.STRING(36),
    job_request_id: DataTypes.INTEGER.UNSIGNED,
    activation_job_request_id: DataTypes.INTEGER.UNSIGNED,
    rollback_job_request_id: DataTypes.INTEGER.UNSIGNED,
    idempotency_key: { type: DataTypes.STRING(191), allowNull: false },
    activation_idempotency_key: DataTypes.STRING(191),
    rollback_idempotency_key: DataTypes.STRING(191),
    plan_id: { type: DataTypes.STRING(191), allowNull: false },
    plan_hash: { type: DataTypes.STRING(64), allowNull: false },
    plan_snapshot: { type: DataTypes.JSON, allowNull: false },
    campaign_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    provider: { type: DataTypes.STRING(32), allowNull: false },
    family: { type: DataTypes.STRING(64), allowNull: false },
    operation: { type: DataTypes.STRING(32), allowNull: false },
    status: {
      type: DataTypes.ENUM(
        'queued', 'executing', 'succeeded', 'activation_queued', 'activating', 'active',
        'activation_failed', 'failed', 'manual_recovery_required',
        'rollback_queued', 'rolling_back', 'rolled_back', 'cancelled'
      ),
      allowNull: false,
      defaultValue: 'queued',
    },
    reservation_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false },
    change_reference: { type: DataTypes.STRING(191), allowNull: false },
    authorization_snapshot: { type: DataTypes.JSON, allowNull: false },
    provider_refs: { type: DataTypes.JSON, allowNull: false },
    ownership_snapshot: { type: DataTypes.JSON, allowNull: false },
    activation_authorization_snapshot: DataTypes.JSON,
    goal_policy_snapshot: DataTypes.JSON,
    activation_snapshot: DataTypes.JSON,
    rollback_snapshot: DataTypes.JSON,
    lease_owner: { type: DataTypes.STRING(64), allowNull: true },
    lease_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    lease_expires_at: { type: DataTypes.DATE, allowNull: true },
    requested_by_user_id: { type: DataTypes.INTEGER, allowNull: false },
    activation_requested_by_user_id: DataTypes.INTEGER,
    rollback_requested_by_user_id: DataTypes.INTEGER,
    attempt_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    activation_attempt_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    activation_change_reference: DataTypes.STRING(191),
    started_at: DataTypes.DATE,
    completed_at: DataTypes.DATE,
    activation_requested_at: DataTypes.DATE,
    activated_at: DataTypes.DATE,
    rolled_back_at: DataTypes.DATE,
    error_code: DataTypes.STRING(128),
    error_message: DataTypes.TEXT,
  }, {
    sequelize,
    modelName: 'ManagedCampaignProviderExecution',
    tableName: 'ManagedCampaignProviderExecutions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
    indexes: [
      { name: 'uniq_managed_provider_execution_idempotency', unique: true, fields: ['managed_campaign_id', 'idempotency_key'] },
      { name: 'idx_managed_provider_execution_campaign_status', fields: ['managed_campaign_id', 'status', 'created_at'] },
      { name: 'idx_managed_provider_execution_job', fields: ['job_request_id'] },
      { name: 'idx_managed_provider_execution_activation_job', fields: ['activation_job_request_id'] },
      { name: 'idx_managed_provider_execution_rollback_job', fields: ['rollback_job_request_id'] },
      { name: 'idx_managed_provider_execution_plan_hash', fields: ['plan_hash'] },
      { name: 'idx_managed_provider_execution_lease', fields: ['status', 'lease_expires_at'] },
    ],
  });

  return ManagedCampaignProviderExecution;
};
