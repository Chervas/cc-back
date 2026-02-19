'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AutomationFlowTemplateV2 extends Model {
    static associate(models) {
      if (models.Clinica) {
        AutomationFlowTemplateV2.belongsTo(models.Clinica, {
          foreignKey: 'clinic_id',
          targetKey: 'id_clinica',
          as: 'clinic',
        });
      }
      if (models.GrupoClinica) {
        AutomationFlowTemplateV2.belongsTo(models.GrupoClinica, {
          foreignKey: 'group_id',
          targetKey: 'id_grupo',
          as: 'group',
        });
      }
      if (models.FlowExecutionV2) {
        AutomationFlowTemplateV2.hasMany(models.FlowExecutionV2, {
          foreignKey: 'template_version_id',
          sourceKey: 'id',
          as: 'executions',
        });
      }
    }
  }

  AutomationFlowTemplateV2.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    template_key: { type: DataTypes.STRING(120), allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    engine_version: { type: DataTypes.ENUM('v1', 'v2'), allowNull: false, defaultValue: 'v2' },
    name: { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    trigger_type: { type: DataTypes.STRING(80), allowNull: false },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    group_id: { type: DataTypes.INTEGER, allowNull: true },
    entry_node_id: { type: DataTypes.STRING(32), allowNull: false },
    nodes: { type: DataTypes.JSON, allowNull: false },
    published_at: { type: DataTypes.DATE, allowNull: true },
    published_by: { type: DataTypes.INTEGER, allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: false },
  }, {
    sequelize,
    modelName: 'AutomationFlowTemplateV2',
    tableName: 'AutomationFlowTemplatesV2',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return AutomationFlowTemplateV2;
};
