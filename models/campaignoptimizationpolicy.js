'use strict';

module.exports = (sequelize, DataTypes) => {
  const CampaignOptimizationPolicy = sequelize.define('CampaignOptimizationPolicy', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    scopeType: { type: DataTypes.ENUM('clinic', 'group'), allowNull: false, field: 'scope_type' },
    scopeId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'scope_id' },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinica_id' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupo_clinica_id' },
    mode: { type: DataTypes.ENUM('connect_only', 'managed_service'), allowNull: false },
    strategyId: { type: DataTypes.INTEGER, allowNull: true, field: 'strategy_id' },
    managedCampaignId: { type: DataTypes.STRING(36), allowNull: true, field: 'managed_campaign_id' },
    customerIds: { type: DataTypes.JSON, allowNull: false, field: 'customer_ids', defaultValue: [] },
    campaignIds: { type: DataTypes.JSON, allowNull: false, field: 'campaign_ids', defaultValue: [] },
    lifecycleState: { type: DataTypes.JSON, allowNull: false, field: 'lifecycle_state' },
    thresholds: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    status: {
      type: DataTypes.ENUM('active', 'paused', 'completed', 'archived'),
      allowNull: false,
      defaultValue: 'paused'
    },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    nextEvaluationAt: { type: DataTypes.DATE, allowNull: true, field: 'next_evaluation_at' },
    lastEvaluatedAt: { type: DataTypes.DATE, allowNull: true, field: 'last_evaluated_at' }
  }, {
    tableName: 'CampaignOptimizationPolicies',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['status', 'next_evaluation_at'] },
      { fields: ['scope_type', 'scope_id', 'status'] },
      { fields: ['managed_campaign_id'], unique: true, name: 'uniq_campaign_optimization_policy_managed_campaign' },
      { fields: ['strategy_id'] }
    ],
    validate: {
      coherentScope() {
        const clinic = this.scopeType === 'clinic';
        if (clinic && (Number(this.clinicaId) !== Number(this.scopeId) || this.grupoClinicaId != null)) {
          throw new Error('El alcance clinic debe usar únicamente clinica_id=scope_id');
        }
        if (!clinic && (Number(this.grupoClinicaId) !== Number(this.scopeId) || this.clinicaId != null)) {
          throw new Error('El alcance group debe usar únicamente grupo_clinica_id=scope_id');
        }
      }
    }
  });

  CampaignOptimizationPolicy.associate = function associate(models) {
    CampaignOptimizationPolicy.belongsTo(models.Clinica, {
      foreignKey: 'clinicaId',
      targetKey: 'id_clinica',
      as: 'clinica'
    });
    CampaignOptimizationPolicy.belongsTo(models.GrupoClinica, {
      foreignKey: 'grupoClinicaId',
      targetKey: 'id_grupo',
      as: 'grupoClinica'
    });
    CampaignOptimizationPolicy.belongsTo(models.ManagedCampaign, {
      foreignKey: 'managedCampaignId',
      as: 'managedCampaign'
    });
    CampaignOptimizationPolicy.belongsTo(models.Campaign, {
      foreignKey: 'strategyId',
      as: 'strategy'
    });
    CampaignOptimizationPolicy.hasMany(models.CampaignOptimizationEvaluation, {
      foreignKey: 'policyId',
      as: 'evaluations'
    });
  };

  return CampaignOptimizationPolicy;
};
