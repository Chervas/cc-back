'use strict';

module.exports = (sequelize, DataTypes) => sequelize.define('MetaSignalDelivery', {
  id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true },
  dedupe_key: { type: DataTypes.STRING(64), allowNull: false },
  clinic_id: { type: DataTypes.INTEGER, allowNull: false },
  account_id: { type: DataTypes.STRING(64), allowNull: false },
  campaign_id: { type: DataTypes.STRING(64), allowNull: true },
  dataset_id: { type: DataTypes.STRING(64), allowNull: false },
  destination_key: { type: DataTypes.STRING(64), allowNull: false },
  event_name: { type: DataTypes.STRING(32), allowNull: false },
  event_key: { type: DataTypes.STRING(64), allowNull: false },
  occurred_at: { type: DataTypes.DATE, allowNull: false },
  status: { type: DataTypes.ENUM('pending', 'accepted', 'warning', 'failed', 'unknown', 'skipped'), allowNull: false },
  attempt_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
  lease_id: { type: DataTypes.STRING(36), allowNull: true },
  attempted_at: { type: DataTypes.DATE, allowNull: false },
  completed_at: { type: DataTypes.DATE, allowNull: true },
  policy_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  policy_refs: { type: DataTypes.JSON, allowNull: false },
  reason: { type: DataTypes.STRING(128), allowNull: true },
  events_received: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  warning_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  trace_id: { type: DataTypes.STRING(191), allowNull: true },
}, {
  tableName: 'MetaSignalDeliveries', createdAt: 'created_at', updatedAt: 'updated_at',
  indexes: [{ name: 'uniq_meta_signal_delivery', unique: true, fields: ['dedupe_key'] },
    { name: 'idx_meta_signal_campaign_time', fields: ['clinic_id', 'account_id', 'campaign_id', 'attempted_at'] }],
});
