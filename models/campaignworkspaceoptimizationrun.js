'use strict';

module.exports = (sequelize, DataTypes) => sequelize.define('CampaignWorkspaceOptimizationRun', {
  id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
  runtime_namespace: { type: DataTypes.STRING(80), allowNull: false },
  setting_id: { type: DataTypes.STRING(36), allowNull: false },
  mandate_id: { type: DataTypes.STRING(36), allowNull: false },
  plan_key: { type: DataTypes.STRING(64), allowNull: false },
  provider: { type: DataTypes.STRING(16), allowNull: false },
  account_id: { type: DataTypes.STRING(64), allowNull: false },
  campaign_id: { type: DataTypes.STRING(64), allowNull: false },
  resource_key: { type: DataTypes.STRING(64), allowNull: false },
  change: { type: DataTypes.JSON, allowNull: false },
  evidence: { type: DataTypes.JSON, allowNull: false },
  status: { type: DataTypes.ENUM('queued', 'leased', 'submitted', 'verified', 'observed', 'skipped', 'uncertain'), allowNull: false, defaultValue: 'queued' },
  job_request_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  lease_token: { type: DataTypes.STRING(36), allowNull: true },
  lease_until: { type: DataTypes.DATE, allowNull: true },
  submitted_at: { type: DataTypes.DATE, allowNull: true },
  completed_at: { type: DataTypes.DATE, allowNull: true },
  outcome: { type: DataTypes.JSON, allowNull: true },
}, {
  tableName: 'CampaignWorkspaceOptimizationRuns', createdAt: 'created_at', updatedAt: 'updated_at',
  indexes: [
    { name: 'uniq_workspace_optimization_plan', unique: true, fields: ['setting_id', 'plan_key'] },
    { name: 'idx_workspace_optimization_account', fields: ['provider', 'account_id', 'status'] },
    { name: 'idx_workspace_optimization_resource', fields: ['resource_key', 'submitted_at'] },
    { name: 'idx_workspace_optimization_pending', fields: ['runtime_namespace', 'status', 'updated_at'] },
  ],
});
