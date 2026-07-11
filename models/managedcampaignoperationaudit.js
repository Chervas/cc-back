'use strict';

const { Model } = require('sequelize');

function rejectAuditMutation() {
  const error = new Error('Managed campaign operation audits are append-only');
  error.code = 'managed_campaign_operation_audit_append_only';
  throw error;
}

module.exports = (sequelize, DataTypes) => {
  class ManagedCampaignOperationAudit extends Model {
    static associate(models) {
      if (models.ManagedCampaign) {
        ManagedCampaignOperationAudit.belongsTo(models.ManagedCampaign, {
          foreignKey: 'managed_campaign_id',
          as: 'campaign',
        });
      }
      if (models.Usuario) {
        ManagedCampaignOperationAudit.belongsTo(models.Usuario, {
          foreignKey: 'actor_user_id',
          targetKey: 'id_usuario',
          as: 'actor',
        });
      }
    }
  }

  ManagedCampaignOperationAudit.init({
    id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
    managed_campaign_id: { type: DataTypes.STRING(36), allowNull: false },
    event_type: { type: DataTypes.STRING(64), allowNull: false },
    actor_user_id: { type: DataTypes.INTEGER, allowNull: false },
    from_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    to_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    changes: { type: DataTypes.JSON, allowNull: false },
  }, {
    sequelize,
    modelName: 'ManagedCampaignOperationAudit',
    tableName: 'ManagedCampaignOperationAudits',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    underscored: true,
    indexes: [
      { fields: ['managed_campaign_id', 'created_at'] },
      { fields: ['actor_user_id', 'created_at'] },
    ],
    hooks: {
      beforeUpdate: rejectAuditMutation,
      beforeBulkUpdate: rejectAuditMutation,
      beforeDestroy: rejectAuditMutation,
      beforeBulkDestroy: rejectAuditMutation,
    },
  });

  return ManagedCampaignOperationAudit;
};
