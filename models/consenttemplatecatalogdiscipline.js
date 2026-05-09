'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ConsentTemplateCatalogDiscipline extends Model {
    static associate(models) {
      ConsentTemplateCatalogDiscipline.belongsTo(models.ConsentTemplateCatalog, {
        foreignKey: 'catalog_id',
        as: 'catalog',
      });
    }
  }

  ConsentTemplateCatalogDiscipline.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    catalog_id: { type: DataTypes.INTEGER, allowNull: false },
    disciplina_code: { type: DataTypes.STRING(80), allowNull: false },
  }, {
    sequelize,
    modelName: 'ConsentTemplateCatalogDiscipline',
    tableName: 'ConsentTemplateCatalogDisciplines',
    timestamps: true,
  });

  return ConsentTemplateCatalogDiscipline;
};
