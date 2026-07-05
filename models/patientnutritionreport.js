'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientNutritionReport extends Model {
    static associate(models) {
      if (models.PatientNutritionMeasurement) {
        PatientNutritionReport.belongsTo(models.PatientNutritionMeasurement, {
          foreignKey: 'measurement_id',
          as: 'measurement',
        });
      }
      if (models.Paciente) {
        PatientNutritionReport.belongsTo(models.Paciente, {
          foreignKey: 'patient_id',
          targetKey: 'id_paciente',
          as: 'patient',
        });
      }
      if (models.Clinica) {
        PatientNutritionReport.belongsTo(models.Clinica, {
          foreignKey: 'clinic_id',
          targetKey: 'id_clinica',
          as: 'clinic',
        });
      }
      if (models.CitaPaciente) {
        PatientNutritionReport.belongsTo(models.CitaPaciente, {
          foreignKey: 'appointment_id',
          targetKey: 'id_cita',
          as: 'appointment',
        });
      }
      if (models.Tratamiento) {
        PatientNutritionReport.belongsTo(models.Tratamiento, {
          foreignKey: 'treatment_id',
          targetKey: 'id_tratamiento',
          as: 'treatment',
        });
      }
      if (models.Usuario) {
        PatientNutritionReport.belongsTo(models.Usuario, {
          foreignKey: 'generated_by',
          targetKey: 'id_usuario',
          as: 'generatedBy',
        });
        PatientNutritionReport.belongsTo(models.Usuario, {
          foreignKey: 'finalized_by',
          targetKey: 'id_usuario',
          as: 'finalizedBy',
        });
      }
    }
  }

  PatientNutritionReport.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    measurement_id: { type: DataTypes.INTEGER, allowNull: false },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    appointment_id: { type: DataTypes.INTEGER, allowNull: true },
    treatment_id: { type: DataTypes.INTEGER, allowNull: true },
    report_type: { type: DataTypes.STRING(60), allowNull: false },
    title: { type: DataTypes.STRING(255), allowNull: false },
    status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'active' },
    formula_version: { type: DataTypes.STRING(80), allowNull: false },
    snapshot_json: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    snapshot_html: { type: DataTypes.TEXT, allowNull: true },
    snapshot_hash: { type: DataTypes.STRING(128), allowNull: false },
    pdf_asset_id: { type: DataTypes.INTEGER, allowNull: true },
    storage_strategy: {
      type: DataTypes.STRING(80),
      allowNull: false,
      defaultValue: 'json_snapshot_printable_on_demand',
    },
    generated_by: { type: DataTypes.INTEGER, allowNull: true },
    generated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    finalized_by: { type: DataTypes.INTEGER, allowNull: true },
    finalized_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    sequelize,
    modelName: 'PatientNutritionReport',
    tableName: 'PatientNutritionReports',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return PatientNutritionReport;
};
