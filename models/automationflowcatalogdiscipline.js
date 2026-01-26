'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AutomationFlowCatalogDiscipline extends Model {
    static associate(models) {
      AutomationFlowCatalogDiscipline.belongsTo(models.AutomationFlowCatalog, {
        foreignKey: 'flow_catalog_id',
        as: 'catalog',
      });
    }
  }

  AutomationFlowCatalogDiscipline.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      flow_catalog_id: { type: DataTypes.INTEGER, allowNull: false },
      disciplina_code: { type: DataTypes.STRING(50), allowNull: false },
    },
    {
      sequelize,
      modelName: 'AutomationFlowCatalogDiscipline',
      tableName: 'AutomationFlowCatalogDisciplines',
      timestamps: false,
    }
  );

  return AutomationFlowCatalogDiscipline;
};
