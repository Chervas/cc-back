'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ClinicConsentTemplate extends Model {
    static associate(models) {
      ClinicConsentTemplate.belongsTo(models.Clinica, {
        foreignKey: 'clinic_id',
        targetKey: 'id_clinica',
        as: 'clinic',
      });
      ClinicConsentTemplate.belongsTo(models.ConsentTemplateCatalog, {
        foreignKey: 'source_catalog_id',
        as: 'sourceCatalog',
      });
      ClinicConsentTemplate.hasMany(models.ClinicConsentTemplateVersion, {
        foreignKey: 'clinic_template_id',
        as: 'versions',
      });
      ClinicConsentTemplate.hasMany(models.TreatmentConsentRequirement, {
        foreignKey: 'clinic_template_id',
        as: 'treatmentRequirements',
      });
    }
  }

  ClinicConsentTemplate.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    source_catalog_id: { type: DataTypes.INTEGER, allowNull: true },
    source_catalog_version_id: { type: DataTypes.INTEGER, allowNull: true },
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
    is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    requires_patient_signature: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    requires_representative_when_minor: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    requires_professional_signature: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'ClinicConsentTemplate',
    tableName: 'ClinicConsentTemplates',
    timestamps: true,
  });

  return ClinicConsentTemplate;
};
