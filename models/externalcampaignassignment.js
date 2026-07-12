'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ExternalCampaignAssignment extends Model {
    static associate(models) {
      if (models.ExternalCampaignInventory) {
        ExternalCampaignAssignment.belongsTo(models.ExternalCampaignInventory, {
          foreignKey: 'inventory_id',
          as: 'inventory',
        });
      }
      if (models.Clinica) {
        ExternalCampaignAssignment.belongsTo(models.Clinica, {
          foreignKey: 'clinica_id',
          targetKey: 'id_clinica',
          as: 'clinic',
        });
      }
      if (models.Campaign) {
        ExternalCampaignAssignment.belongsTo(models.Campaign, {
          foreignKey: 'strategy_campaign_id',
          as: 'strategy_campaign',
        });
      }
      if (models.CampaignRequest) {
        ExternalCampaignAssignment.belongsTo(models.CampaignRequest, {
          foreignKey: 'campaign_request_id',
          as: 'target_request',
        });
      }
      if (models.Tratamiento) {
        ExternalCampaignAssignment.belongsTo(models.Tratamiento, {
          foreignKey: 'target_treatment_id',
          targetKey: 'id_tratamiento',
          as: 'target_treatment',
        });
      }
      if (models.ExternalCampaignAssignmentAudit) {
        ExternalCampaignAssignment.hasMany(models.ExternalCampaignAssignmentAudit, {
          foreignKey: 'assignment_id',
          as: 'audits',
        });
      }
    }
  }

  ExternalCampaignAssignment.init({
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    inventory_id: DataTypes.BIGINT,
    provider: { type: DataTypes.ENUM('google_ads', 'meta_ads'), allowNull: false },
    customer_id: { type: DataTypes.STRING(64), allowNull: false },
    campaign_id: { type: DataTypes.STRING(128), allowNull: false },
    campaign_name_snapshot: DataTypes.STRING(512),
    grupo_clinica_id: DataTypes.INTEGER,
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    match_kind: { type: DataTypes.ENUM('exact', 'alias', 'fuzzy', 'manual'), allowNull: false, defaultValue: 'manual' },
    match_confidence: DataTypes.DECIMAL(5, 4),
    match_explanation: DataTypes.STRING(512),
    status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
    archive_reason: DataTypes.STRING(1024),
    archived_by_user_id: DataTypes.INTEGER,
    archived_at: DataTypes.DATE,
    strategy_campaign_id: DataTypes.INTEGER,
    campaign_request_id: DataTypes.INTEGER,
    target_kind: DataTypes.ENUM('generic', 'treatment'),
    target_treatment_id: DataTypes.INTEGER,
    target_confidence: DataTypes.DECIMAL(5, 4),
    target_explanation: DataTypes.STRING(1024),
    target_updated_by_user_id: DataTypes.INTEGER,
    target_updated_at: DataTypes.DATE,
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    approved_by_user_id: DataTypes.INTEGER,
    approved_at: DataTypes.DATE,
  }, {
    sequelize,
    modelName: 'ExternalCampaignAssignment',
    tableName: 'ExternalCampaignAssignments',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
  });

  return ExternalCampaignAssignment;
};
