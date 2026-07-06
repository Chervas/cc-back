'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientNutritionMeasurement extends Model {
    static associate(models) {
      if (models.Paciente) {
        PatientNutritionMeasurement.belongsTo(models.Paciente, {
          foreignKey: 'patient_id',
          targetKey: 'id_paciente',
          as: 'patient',
        });
      }
      if (models.Clinica) {
        PatientNutritionMeasurement.belongsTo(models.Clinica, {
          foreignKey: 'clinic_id',
          targetKey: 'id_clinica',
          as: 'clinic',
        });
      }
      if (models.Usuario) {
        PatientNutritionMeasurement.belongsTo(models.Usuario, {
          foreignKey: 'professional_id',
          targetKey: 'id_usuario',
          as: 'professional',
        });
      }
      if (models.CitaPaciente) {
        PatientNutritionMeasurement.belongsTo(models.CitaPaciente, {
          foreignKey: 'appointment_id',
          targetKey: 'id_cita',
          as: 'appointment',
        });
      }
      if (models.Tratamiento) {
        PatientNutritionMeasurement.belongsTo(models.Tratamiento, {
          foreignKey: 'treatment_id',
          targetKey: 'id_tratamiento',
          as: 'treatment',
        });
      }
      if (models.PatientNutritionReport) {
        PatientNutritionMeasurement.hasMany(models.PatientNutritionReport, {
          foreignKey: 'measurement_id',
          as: 'reports',
        });
      }
    }
  }

  PatientNutritionMeasurement.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    professional_id: { type: DataTypes.INTEGER, allowNull: true },
    appointment_id: { type: DataTypes.INTEGER, allowNull: true },
    treatment_id: { type: DataTypes.INTEGER, allowNull: true },
    profile_code: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'quick' },
    measured_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    raw_values_json: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    calculated_values_json: { type: DataTypes.JSON, allowNull: true },
    formula_version: { type: DataTypes.STRING(80), allowNull: false, defaultValue: 'nutrition-basic-v1' },
    quality_flags_json: { type: DataTypes.JSON, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
    updated_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'PatientNutritionMeasurement',
    tableName: 'PatientNutritionMeasurements',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return PatientNutritionMeasurement;
};
