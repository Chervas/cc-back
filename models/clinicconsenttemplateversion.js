'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ClinicConsentTemplateVersion extends Model {
    static associate(models) {
      ClinicConsentTemplateVersion.belongsTo(models.ClinicConsentTemplate, {
        foreignKey: 'clinic_template_id',
        as: 'template',
      });
      ClinicConsentTemplateVersion.belongsTo(models.ConsentTemplateCatalogVersion, {
        foreignKey: 'source_catalog_version_id',
        as: 'sourceVersion',
      });
    }
  }

  ClinicConsentTemplateVersion.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinic_template_id: { type: DataTypes.INTEGER, allowNull: false },
    source_catalog_version_id: { type: DataTypes.INTEGER, allowNull: true },
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
    modelName: 'ClinicConsentTemplateVersion',
    tableName: 'ClinicConsentTemplateVersions',
    timestamps: true,
  });

  return ClinicConsentTemplateVersion;
};
