'use strict';
module.exports = (sequelize, D) => sequelize.define('AwsInfrastructureCostCache', {
  cache_key: { type: D.STRING(96), primaryKey: true },
  snapshot: { type: D.JSON, allowNull: true },
  collected_at: { type: D.DATE, allowNull: true },
  last_attempt_at: { type: D.DATE, allowNull: true },
  last_error_code: { type: D.STRING(64), allowNull: true },
  lease_token: { type: D.UUID, allowNull: true },
  lease_until: { type: D.DATE, allowNull: true },
}, { tableName: 'AwsInfrastructureCostCaches', createdAt: 'created_at', updatedAt: 'updated_at',
  indexes: [{ name: 'idx_aws_cost_cache_lease', fields: ['lease_until'] }] });
