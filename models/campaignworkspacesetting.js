'use strict';

module.exports = (sequelize, DataTypes) => sequelize.define('CampaignWorkspaceSetting', {
  id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
  scope_type: { type: DataTypes.ENUM('clinic', 'group'), allowNull: false },
  scope_id: { type: DataTypes.INTEGER, allowNull: false },
  version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
  accounts: { type: DataTypes.JSON, allowNull: false },
  activation: { type: DataTypes.JSON, allowNull: true },
  preferences: { type: DataTypes.JSON, allowNull: true },
  signal_preparation: { type: DataTypes.JSON, allowNull: true },
  updated_by_user_id: { type: DataTypes.INTEGER, allowNull: false },
}, {
  tableName: 'CampaignWorkspaceSettings', createdAt: 'created_at', updatedAt: 'updated_at',
  indexes: [{ name: 'uniq_campaign_workspace_scope', unique: true, fields: ['scope_type', 'scope_id'] }],
});
