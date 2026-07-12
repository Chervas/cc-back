'use strict';
const { Model } = require('sequelize');

function rejectAuditMutation() {
  const error = new Error('External campaign assignment audits are append-only');
  error.code = 'external_campaign_assignment_audit_append_only';
  throw error;
}

module.exports = (sequelize, DataTypes) => {
  class ExternalCampaignAssignmentAudit extends Model {
    static associate(models) {
      if (models.ExternalCampaignAssignment) {
        ExternalCampaignAssignmentAudit.belongsTo(models.ExternalCampaignAssignment, {
          foreignKey: 'assignment_id',
          as: 'assignment',
        });
      }
      if (models.Usuario) {
        ExternalCampaignAssignmentAudit.belongsTo(models.Usuario, {
          foreignKey: 'actor_user_id',
          targetKey: 'id_usuario',
          as: 'actor',
        });
      }
    }
  }

  ExternalCampaignAssignmentAudit.init({
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    assignment_id: { type: DataTypes.BIGINT, allowNull: false },
    event_type: { type: DataTypes.STRING(64), allowNull: false },
    actor_type: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'user' },
    actor_user_id: DataTypes.INTEGER,
    from_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    to_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    reason: DataTypes.STRING(1024),
    changes: { type: DataTypes.JSON, allowNull: false },
  }, {
    sequelize,
    modelName: 'ExternalCampaignAssignmentAudit',
    tableName: 'ExternalCampaignAssignmentAudits',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    underscored: true,
    hooks: {
      beforeUpdate: rejectAuditMutation,
      beforeBulkUpdate: rejectAuditMutation,
      beforeDestroy: rejectAuditMutation,
      beforeBulkDestroy: rejectAuditMutation,
    },
  });

  return ExternalCampaignAssignmentAudit;
};
