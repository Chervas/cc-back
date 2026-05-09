'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientConsentDocument extends Model {
    static associate(models) {
      PatientConsentDocument.belongsTo(models.ConsentSignaturePackage, {
        foreignKey: 'package_id',
        as: 'package',
      });
      PatientConsentDocument.belongsTo(models.Paciente, {
        foreignKey: 'paciente_id',
        targetKey: 'id_paciente',
        as: 'paciente',
      });
      PatientConsentDocument.belongsTo(models.Clinica, {
        foreignKey: 'clinica_id',
        targetKey: 'id_clinica',
        as: 'clinica',
      });
      PatientConsentDocument.belongsTo(models.CitaPaciente, {
        foreignKey: 'cita_id',
        targetKey: 'id_cita',
        as: 'cita',
      });
      PatientConsentDocument.belongsTo(models.Tratamiento, {
        foreignKey: 'tratamiento_id',
        targetKey: 'id_tratamiento',
        as: 'tratamiento',
      });
      PatientConsentDocument.belongsTo(models.ClinicConsentTemplate, {
        foreignKey: 'clinic_template_id',
        as: 'clinicTemplate',
      });
      PatientConsentDocument.belongsTo(models.ClinicConsentTemplateVersion, {
        foreignKey: 'clinic_template_version_id',
        as: 'clinicTemplateVersion',
      });
      PatientConsentDocument.belongsTo(models.ConsentTemplateCatalog, {
        foreignKey: 'catalog_template_id',
        as: 'catalogTemplate',
      });
      PatientConsentDocument.belongsTo(models.ConsentTemplateCatalogVersion, {
        foreignKey: 'catalog_template_version_id',
        as: 'catalogTemplateVersion',
      });
    }
  }

  PatientConsentDocument.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    package_id: { type: DataTypes.INTEGER, allowNull: true },
    paciente_id: { type: DataTypes.INTEGER, allowNull: false },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    cita_id: { type: DataTypes.INTEGER, allowNull: true },
    tratamiento_id: { type: DataTypes.INTEGER, allowNull: true },
    clinic_template_id: { type: DataTypes.INTEGER, allowNull: true },
    clinic_template_version_id: { type: DataTypes.INTEGER, allowNull: true },
    catalog_template_id: { type: DataTypes.INTEGER, allowNull: true },
    catalog_template_version_id: { type: DataTypes.INTEGER, allowNull: true },
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
      type: DataTypes.ENUM('pending', 'sent', 'viewed', 'signed', 'rejected', 'revoked', 'expired', 'cancelled', 'superseded', 'voided'),
      allowNull: false,
      defaultValue: 'pending',
    },
    required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    blocking_policy: {
      type: DataTypes.ENUM('hard', 'soft', 'optional'),
      allowNull: false,
      defaultValue: 'hard',
    },
    locale: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'es' },
    title: { type: DataTypes.STRING(255), allowNull: false },
    snapshot_json: { type: DataTypes.JSON, allowNull: true },
    snapshot_html: { type: DataTypes.TEXT, allowNull: true },
    snapshot_hash: { type: DataTypes.STRING(128), allowNull: true },
    signed_by_patient_id: { type: DataTypes.INTEGER, allowNull: true },
    signed_by_representative_id: { type: DataTypes.INTEGER, allowNull: true },
    signed_at: { type: DataTypes.DATE, allowNull: true },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    channel: { type: DataTypes.STRING(40), allowNull: true },
    delivery_status: { type: DataTypes.STRING(40), allowNull: true },
  }, {
    sequelize,
    modelName: 'PatientConsentDocument',
    tableName: 'PatientConsentDocuments',
    timestamps: true,
  });

  return PatientConsentDocument;
};
