'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AutomationFlowCatalog extends Model {
    static associate(models) {
      AutomationFlowCatalog.hasMany(models.AutomationFlowCatalogDiscipline, {
        foreignKey: 'flow_catalog_id',
        as: 'disciplinas',
      });
    }
  }

  AutomationFlowCatalog.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      display_name: { type: DataTypes.STRING(150), allowNull: true },
      description: { type: DataTypes.TEXT, allowNull: true },
      trigger_type: { type: DataTypes.STRING(50), allowNull: false },
      steps: { type: DataTypes.JSON, allowNull: false },
      is_generic: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      sequelize,
      modelName: 'AutomationFlowCatalog',
      tableName: 'AutomationFlowCatalog',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return AutomationFlowCatalog;
};
