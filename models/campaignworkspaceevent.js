'use strict';

module.exports = (sequelize, DataTypes) => sequelize.define('CampaignWorkspaceEvent', {
  id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
  setting_id: { type: DataTypes.STRING(36), allowNull: false },
  version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  event_type: { type: DataTypes.STRING(40), allowNull: false },
  actor_user_id: { type: DataTypes.INTEGER, allowNull: false },
  changes: { type: DataTypes.JSON, allowNull: false },
  created_at: { type: DataTypes.DATE, allowNull: false },
}, {
  tableName: 'CampaignWorkspaceEvents', timestamps: false,
  indexes: [{ name: 'uniq_campaign_workspace_event_version', unique: true, fields: ['setting_id', 'version'] }],
});
