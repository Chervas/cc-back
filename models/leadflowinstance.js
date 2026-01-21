'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class LeadFlowInstance extends Model {
    static associate(models) {
      if (models.LeadIntake) {
        LeadFlowInstance.belongsTo(models.LeadIntake, { foreignKey: 'lead_id', as: 'lead' });
      }
      if (models.AutomationFlow) {
        LeadFlowInstance.belongsTo(models.AutomationFlow, { foreignKey: 'flow_id', as: 'flow' });
      }
    }
  }

  LeadFlowInstance.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    lead_id: { type: DataTypes.INTEGER, allowNull: false },
    flow_id: { type: DataTypes.INTEGER, allowNull: false },
    paso_actual: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    datos_recopilados: { type: DataTypes.JSON, allowNull: true, defaultValue: {} },
    historial_acciones: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
    estado: {
      type: DataTypes.ENUM('activo', 'completado', 'cancelado'),
      allowNull: false,
      defaultValue: 'activo'
    }
  }, {
    sequelize,
    modelName: 'LeadFlowInstance',
    tableName: 'LeadFlowInstances',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return LeadFlowInstance;
};
