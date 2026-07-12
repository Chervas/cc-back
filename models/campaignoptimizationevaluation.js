'use strict';

function appendOnlyError() {
  throw new Error('CampaignOptimizationEvaluation es append-only');
}

module.exports = (sequelize, DataTypes) => {
  const CampaignOptimizationEvaluation = sequelize.define('CampaignOptimizationEvaluation', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    policyId: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, field: 'policy_id' },
    policyVersion: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'policy_version' },
    evaluationDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'evaluation_date' },
    evaluatedAt: { type: DataTypes.DATE, allowNull: false, field: 'evaluated_at' },
    metrics: { type: DataTypes.JSON, allowNull: false },
    evidence: { type: DataTypes.JSON, allowNull: false },
    blockers: { type: DataTypes.JSON, allowNull: false },
    decisionDigest: { type: DataTypes.STRING(64), allowNull: false, field: 'decision_digest' },
    eligibleNow: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'eligible_now' },
    readyForApproval: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'ready_for_approval' },
    status: {
      type: DataTypes.ENUM('blocked', 'observing', 'ready', 'terminal', 'error'),
      allowNull: false,
      defaultValue: 'blocked'
    }
  }, {
    tableName: 'CampaignOptimizationEvaluations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
      { unique: true, fields: ['policy_id', 'evaluation_date'] },
      { fields: ['policy_id', 'evaluated_at'] },
      { fields: ['status', 'evaluated_at'] }
    ],
    hooks: {
      beforeUpdate: appendOnlyError,
      beforeDestroy: appendOnlyError,
      beforeBulkUpdate: appendOnlyError,
      beforeBulkDestroy: appendOnlyError
    }
  });

  CampaignOptimizationEvaluation.associate = function associate(models) {
    CampaignOptimizationEvaluation.belongsTo(models.CampaignOptimizationPolicy, {
      foreignKey: 'policyId',
      as: 'policy',
      onDelete: 'RESTRICT'
    });
  };

  return CampaignOptimizationEvaluation;
};
