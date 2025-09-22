'use strict';

module.exports = (sequelize, DataTypes) => {
  const ApiUsageCounter = sequelize.define('ApiUsageCounter', {
    provider: { type: DataTypes.STRING(32), primaryKey: true },
    usageDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'usage_date' },
    requestCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'request_count' },
    usagePct: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0, field: 'usage_pct' },
    pauseUntil: { type: DataTypes.DATE, allowNull: true, field: 'pause_until' },
    metadata: { type: DataTypes.JSON, allowNull: true }
  }, {
    tableName: 'ApiUsageCounters',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return ApiUsageCounter;
};
