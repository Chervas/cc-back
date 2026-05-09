'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ConsentTemplateCatalog extends Model {
    static associate(models) {
      ConsentTemplateCatalog.hasMany(models.ConsentTemplateCatalogVersion, {
        foreignKey: 'catalog_id',
        as: 'versions',
      });
      ConsentTemplateCatalog.hasMany(models.ConsentTemplateCatalogDiscipline, {
        foreignKey: 'catalog_id',
        as: 'disciplines',
      });
      ConsentTemplateCatalog.hasMany(models.ConsentTemplateCatalogTreatment, {
        foreignKey: 'catalog_id',
        as: 'treatments',
      });
      ConsentTemplateCatalog.hasMany(models.ClinicConsentTemplate, {
        foreignKey: 'source_catalog_id',
        as: 'clinicCopies',
      });
      ConsentTemplateCatalog.hasMany(models.TreatmentConsentRequirement, {
        foreignKey: 'catalog_template_id',
        as: 'treatmentRequirements',
      });
    }
  }

  ConsentTemplateCatalog.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    catalog_key: { type: DataTypes.STRING(160), allowNull: true },
    name: { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    purpose: {
      type: DataTypes.ENUM(
        'clinical',
        'data_protection',
        'clinical_image',
        'marketing_image',
        'commercial_communications',
        'financial',
        'revocation',
        'other'
      ),
      allowNull: false,
      defaultValue: 'clinical',
    },
    status: {
      type: DataTypes.ENUM('draft', 'active', 'archived'),
      allowNull: false,
      defaultValue: 'draft',
    },
    blocking_policy: {
      type: DataTypes.ENUM('hard', 'soft', 'optional'),
      allowNull: false,
      defaultValue: 'hard',
    },
    validity_mode: {
      type: DataTypes.ENUM('single_act', 'treatment_episode', 'treatment_plan', 'until_date', 'manual'),
      allowNull: false,
      defaultValue: 'single_act',
    },
    is_generic: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    requires_patient_signature: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    requires_representative_when_minor: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    requires_professional_signature: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'ConsentTemplateCatalog',
    tableName: 'ConsentTemplateCatalogs',
    timestamps: true,
  });

  return ConsentTemplateCatalog;
};
