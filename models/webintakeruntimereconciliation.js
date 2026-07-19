'use strict';

module.exports = (sequelize, DataTypes) => {
  const WebIntakeRuntimeReconciliation = sequelize.define('WebIntakeRuntimeReconciliation', {
    id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true, validate: { isUUID: 4 } },
    scopeType: { type: DataTypes.ENUM('clinic', 'group'), allowNull: false, field: 'scope_type' },
    scopeId: { type: DataTypes.INTEGER, allowNull: false, field: 'scope_id' },
    generation: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    sourceRuntimeHash: { type: DataTypes.STRING(64), allowNull: false, field: 'source_runtime_hash' },
    sourceRuntimeFingerprint: {
      type: DataTypes.STRING(64), allowNull: false, field: 'source_runtime_fingerprint',
    },
    targetRuntimeHash: { type: DataTypes.STRING(64), allowNull: false, field: 'target_runtime_hash' },
    targetRuntimeFingerprint: {
      type: DataTypes.STRING(64), allowNull: false, field: 'target_runtime_fingerprint',
    },
    // Envelope AES-256-GCM autenticado. El plaintext nunca se persiste ni se
    // expone como atributo virtual/serializable del modelo.
    targetHmacEnvelope: { type: DataTypes.TEXT, allowNull: true, field: 'target_hmac_envelope' },
    sourceHmacEnvelope: { type: DataTypes.TEXT, allowNull: true, field: 'source_hmac_envelope' },
    sourceConfigPatch: { type: DataTypes.JSON, allowNull: false, field: 'source_config_patch' },
    targetConfigPatch: { type: DataTypes.JSON, allowNull: false, field: 'target_config_patch' },
    status: {
      type: DataTypes.ENUM('pending', 'preparing', 'deploying', 'rolling_back', 'grace', 'completed', 'failed'),
      allowNull: false,
      defaultValue: 'pending',
    },
    expectedDeployments: { type: DataTypes.JSON, allowNull: false, defaultValue: {}, field: 'expected_deployments' },
    lastErrorCode: { type: DataTypes.STRING(128), allowNull: true, field: 'last_error_code' },
    lastErrorMessage: { type: DataTypes.TEXT, allowNull: true, field: 'last_error_message' },
    committedAt: { type: DataTypes.DATE, allowNull: true, field: 'committed_at' },
    graceExpiresAt: { type: DataTypes.DATE, allowNull: true, field: 'grace_expires_at' },
    lastRecoveryRequestId: { type: DataTypes.STRING(80), allowNull: true, field: 'last_recovery_request_id' },
    lastRecoveryRequestHash: { type: DataTypes.STRING(64), allowNull: true, field: 'last_recovery_request_hash' },
    lastRecoveryAction: { type: DataTypes.STRING(32), allowNull: true, field: 'last_recovery_action' },
    lastRecoveryGeneration: {
      type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'last_recovery_generation',
    },
  }, {
    tableName: 'WebIntakeRuntimeReconciliations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { name: 'uniq_web_intake_runtime_reconciliation_scope', unique: true, fields: ['scope_type', 'scope_id'] },
      { name: 'idx_web_intake_runtime_reconciliation_status', fields: ['status', 'updated_at'] },
    ],
  });

  return WebIntakeRuntimeReconciliation;
};
