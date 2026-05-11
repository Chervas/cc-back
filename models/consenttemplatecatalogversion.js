'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ConsentTemplateCatalogVersion extends Model {
    static associate(models) {
      ConsentTemplateCatalogVersion.belongsTo(models.ConsentTemplateCatalog, {
        foreignKey: 'catalog_id',
        as: 'catalog',
      });
    }
  }

  ConsentTemplateCatalogVersion.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    catalog_id: { type: DataTypes.INTEGER, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    locale: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'es' },
    title: { type: DataTypes.STRING(255), allowNull: false },
    body_json: { type: DataTypes.JSON, allowNull: true },
    body_html: { type: DataTypes.TEXT, allowNull: true },
    variable_schema: { type: DataTypes.JSON, allowNull: true },
    status: {
      type: DataTypes.ENUM('draft', 'published', 'archived'),
      allowNull: false,
      defaultValue: 'published',
    },
    published_at: { type: DataTypes.DATE, allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'ConsentTemplateCatalogVersion',
    tableName: 'ConsentTemplateCatalogVersions',
    timestamps: true,
  });

  return ConsentTemplateCatalogVersion;
};
