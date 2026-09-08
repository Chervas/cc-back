'use strict';

module.exports = (sequelize, DataTypes) => sequelize.define('AutomationRateLimitBucket', {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  bucket_key: { type: DataTypes.STRING(255), allowNull: false, unique: true },
  next_available_at: { type: DataTypes.DATE, allowNull: true },
  last_reserved_at: { type: DataTypes.DATE, allowNull: true },
  last_execution_id: { type: DataTypes.INTEGER, allowNull: true },
  metadata: { type: DataTypes.JSON, allowNull: true },
}, {
  tableName: 'AutomationRateLimitBuckets',
  timestamps: true,
  underscored: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});
