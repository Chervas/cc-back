'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AutomationFlow extends Model {
    static associate(models) {
      AutomationFlow.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      AutomationFlow.hasMany(models.MessageLog, { foreignKey: 'flow_id', as: 'logs' });
      if (models.AutomationFlowCatalog) {
        AutomationFlow.belongsTo(models.AutomationFlowCatalog, { foreignKey: 'catalog_flow_id', as: 'catalog' });
      }
    }
  }

  AutomationFlow.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    nombre: { type: DataTypes.STRING(255), allowNull: false },
    descripcion: { type: DataTypes.TEXT, allowNull: true },
    disciplina_id: { type: DataTypes.INTEGER, allowNull: true },
    tratamiento_id: { type: DataTypes.INTEGER, allowNull: true },
    estado: { type: DataTypes.ENUM('borrador', 'activo', 'pausado', 'archivado'), allowNull: false, defaultValue: 'borrador' },
    pasos: { type: DataTypes.JSON, allowNull: true },
    disparador: { type: DataTypes.STRING(128), allowNull: false },
    acciones: { type: DataTypes.JSON, allowNull: false },
    activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    catalog_flow_id: { type: DataTypes.INTEGER, allowNull: true },
    origin: { type: DataTypes.ENUM('catalog', 'custom'), allowNull: false, defaultValue: 'custom' }
  }, {
    sequelize,
    modelName: 'AutomationFlow',
    tableName: 'AutomationFlows',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return AutomationFlow;
};
