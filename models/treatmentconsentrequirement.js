'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class TreatmentConsentRequirement extends Model {
    static associate(models) {
      TreatmentConsentRequirement.belongsTo(models.Tratamiento, {
        foreignKey: 'tratamiento_id',
        as: 'tratamiento',
      });
      TreatmentConsentRequirement.belongsTo(models.Clinica, {
        foreignKey: 'clinica_id',
        targetKey: 'id_clinica',
        as: 'clinica',
      });
      TreatmentConsentRequirement.belongsTo(models.ClinicConsentTemplate, {
        foreignKey: 'clinic_template_id',
        as: 'clinicTemplate',
      });
      TreatmentConsentRequirement.belongsTo(models.ConsentTemplateCatalog, {
        foreignKey: 'catalog_template_id',
        as: 'catalogTemplate',
      });
    }
  }

  TreatmentConsentRequirement.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    tratamiento_id: { type: DataTypes.INTEGER, allowNull: false },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    clinic_template_id: { type: DataTypes.INTEGER, allowNull: true },
    catalog_template_id: { type: DataTypes.INTEGER, allowNull: true },
    requirement_scope: {
      type: DataTypes.ENUM('area', 'treatment', 'conditional'),
      allowNull: false,
      defaultValue: 'treatment',
    },
    condition_key: { type: DataTypes.STRING(120), allowNull: true },
    required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    blocking_policy: {
      type: DataTypes.ENUM('hard', 'soft', 'optional'),
      allowNull: false,
      defaultValue: 'hard',
    },
    sort_order: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    sequelize,
    modelName: 'TreatmentConsentRequirement',
    tableName: 'TreatmentConsentRequirements',
    timestamps: true,
  });

  return TreatmentConsentRequirement;
};
