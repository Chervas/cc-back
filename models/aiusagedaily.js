'use strict';

module.exports = (sequelize, DataTypes) => {
  const AiUsageDaily = sequelize.define('AiUsageDaily', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    usageDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'usage_date' },
    provider: { type: DataTypes.STRING(32), allowNull: false },
    model: { type: DataTypes.STRING(160), allowNull: false },
    useCase: { type: DataTypes.STRING(80), allowNull: false, field: 'use_case' },
    scopeKey: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'global', field: 'scope_key' },
    clinicId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinic_id' },
    groupId: { type: DataTypes.INTEGER, allowNull: true, field: 'group_id' },
    requestCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'request_count' },
    successCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'success_count' },
    errorCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'error_count' },
    fallbackCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'fallback_count' },
    inputTokens: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0, field: 'input_tokens' },
    outputTokens: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0, field: 'output_tokens' },
    latencyMsTotal: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0, field: 'latency_ms_total' },
    estimatedCostUsd: { type: DataTypes.DECIMAL(14, 6), allowNull: false, defaultValue: 0, field: 'estimated_cost_usd' },
    lastStatus: { type: DataTypes.STRING(32), allowNull: true, field: 'last_status' },
    lastErrorCode: { type: DataTypes.STRING(100), allowNull: true, field: 'last_error_code' },
    lastUsedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_used_at' },
    metadata: { type: DataTypes.JSON, allowNull: true },
  }, {
    tableName: 'AiUsageDaily',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['usage_date', 'provider', 'model', 'use_case', 'scope_key'], name: 'uq_ai_usage_daily_scope' },
      { fields: ['usage_date', 'provider'], name: 'idx_ai_usage_daily_provider' },
      { fields: ['usage_date', 'clinic_id'], name: 'idx_ai_usage_daily_clinic' },
    ],
  });

  return AiUsageDaily;
};
