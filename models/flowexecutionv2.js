'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class FlowExecutionV2 extends Model {
    static associate(models) {
      if (models.AutomationFlowTemplateV2) {
        FlowExecutionV2.belongsTo(models.AutomationFlowTemplateV2, {
          foreignKey: 'template_version_id',
          targetKey: 'id',
          as: 'templateVersion',
        });
      }
      if (models.FlowExecutionLogV2) {
        FlowExecutionV2.hasMany(models.FlowExecutionLogV2, {
          foreignKey: 'flow_execution_id',
          sourceKey: 'id',
          as: 'logs',
        });
      }
      if (models.Clinica) {
        FlowExecutionV2.belongsTo(models.Clinica, {
          foreignKey: 'clinic_id',
          targetKey: 'id_clinica',
          as: 'clinic',
        });
      }
      if (models.GrupoClinica) {
        FlowExecutionV2.belongsTo(models.GrupoClinica, {
          foreignKey: 'group_id',
          targetKey: 'id_grupo',
          as: 'group',
        });
      }
    }
  }

  FlowExecutionV2.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    idempotency_key: { type: DataTypes.STRING(255), allowNull: false },
    template_version_id: { type: DataTypes.INTEGER, allowNull: false },
    engine_version: { type: DataTypes.ENUM('v1', 'v2'), allowNull: false, defaultValue: 'v2' },
    status: {
      type: DataTypes.ENUM('running', 'waiting', 'completed', 'failed', 'paused', 'cancelled', 'dead_letter'),
      allowNull: false,
      defaultValue: 'running',
    },
    context: { type: DataTypes.JSON, allowNull: false },
    current_node_id: { type: DataTypes.STRING(32), allowNull: true },
    trigger_type: { type: DataTypes.STRING(80), allowNull: false },
    trigger_entity_type: { type: DataTypes.STRING(80), allowNull: true },
    trigger_entity_id: { type: DataTypes.INTEGER, allowNull: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    group_id: { type: DataTypes.INTEGER, allowNull: true },
    last_error: { type: DataTypes.TEXT, allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: false },
  }, {
    sequelize,
    modelName: 'FlowExecutionV2',
    tableName: 'FlowExecutionsV2',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return FlowExecutionV2;
};
