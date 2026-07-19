'use strict';

module.exports = (sequelize, DataTypes) => sequelize.define('WebContentGenerationQuotaBucket', {
  bucketKeyHash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    primaryKey: true,
    field: 'bucket_key_hash',
    validate: { is: /^[a-f0-9]{64}$/ },
  },
  bucketType: {
    type: DataTypes.ENUM('global', 'user_scope'),
    allowNull: false,
    field: 'bucket_type',
  },
  bucketStart: { type: DataTypes.DATE, allowNull: false, field: 'bucket_start' },
  requestCount: {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: false,
    defaultValue: 0,
    field: 'request_count',
  },
  expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
}, {
  tableName: 'WebContentGenerationQuotaBuckets',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['expires_at'] },
    { fields: ['bucket_type', 'bucket_start'] },
  ],
});
