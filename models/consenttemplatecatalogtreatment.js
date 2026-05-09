'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ConsentTemplateCatalogTreatment extends Model {
    static associate(models) {
      ConsentTemplateCatalogTreatment.belongsTo(models.ConsentTemplateCatalog, {
        foreignKey: 'catalog_id',
        as: 'catalog',
      });
      ConsentTemplateCatalogTreatment.belongsTo(models.Tratamiento, {
        foreignKey: 'tratamiento_id',
        as: 'tratamiento',
      });
    }
  }

  ConsentTemplateCatalogTreatment.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    catalog_id: { type: DataTypes.INTEGER, allowNull: false },
    tratamiento_id: { type: DataTypes.INTEGER, allowNull: false },
  }, {
    sequelize,
    modelName: 'ConsentTemplateCatalogTreatment',
    tableName: 'ConsentTemplateCatalogTreatments',
    timestamps: true,
  });

  return ConsentTemplateCatalogTreatment;
};
