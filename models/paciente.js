'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Paciente extends Model {
    static associate(models) {
      // Cada paciente pertenece a una clínica
      Paciente.belongsTo(models.Clinica, { foreignKey: 'clinica_id', as: 'clinica' });
      // Un paciente puede estar vinculado a varias clínicas del mismo grupo
      if (models.PacienteClinica) {
        Paciente.hasMany(models.PacienteClinica, { foreignKey: 'paciente_id', as: 'clinicasVinculadas' });
      }
      if (models.PacienteRelacion) {
        Paciente.hasMany(models.PacienteRelacion, { foreignKey: 'id_paciente', as: 'relaciones' });
        Paciente.hasMany(models.PacienteRelacion, { foreignKey: 'id_paciente_relacionado', as: 'tutorDe' });
      }
      if (models.PacienteConsentimiento) {
        Paciente.hasMany(models.PacienteConsentimiento, { foreignKey: 'paciente_id', as: 'consentimientos' });
      }
      if (models.PatientCustomField) {
        Paciente.hasMany(models.PatientCustomField, { foreignKey: 'paciente_id', as: 'camposPersonalizados' });
      }
      if (models.PatientNutritionMeasurement) {
        Paciente.hasMany(models.PatientNutritionMeasurement, { foreignKey: 'patient_id', as: 'nutritionMeasurements' });
      }
    }
  }
  Paciente.init({
    id_paciente: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    public_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true
    },
    nombre: {
      type: DataTypes.STRING,
      allowNull: false
    },
    apellidos: {
      type: DataTypes.STRING,
      allowNull: false
    },
    dni: DataTypes.STRING,
    telefono_movil: {
      type: DataTypes.STRING,
      allowNull: true
    },
    email: DataTypes.STRING,
    telefono_secundario: DataTypes.STRING,
    foto: DataTypes.STRING,
    fecha_nacimiento: DataTypes.DATE,
    edad: DataTypes.INTEGER,
    estatura: DataTypes.FLOAT,
    peso: DataTypes.FLOAT,
    sexo: DataTypes.STRING,
    profesion: DataTypes.STRING,
    fecha_alta: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
    fecha_baja: DataTypes.DATE,
    alergias: DataTypes.TEXT,
    antecedentes: DataTypes.TEXT,
    medicacion: DataTypes.TEXT,
    idioma_preferido: {
      type: DataTypes.ENUM('es', 'ca', 'en'),
      allowNull: false,
      defaultValue: 'es',
      validate: {
        isIn: [['es', 'ca', 'en']]
      }
    },
    idioma_preferido_label: {
      type: DataTypes.VIRTUAL,
      get() {
        const labels = { es: 'Español', ca: 'Catalán', en: 'Inglés' };
        const language = this.getDataValue('idioma_preferido') || 'es';
        return labels[language] || labels.es;
      }
    },
    paciente_conocido: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    como_nos_conocio: {
      type: DataTypes.ENUM('redes sociales', 'buscadores', 'recomendación', 'otros'),
      allowNull: true
    },
    procedencia: DataTypes.INTEGER,
    clinica_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'Clinicas',
        key: 'id_clinica'
      }
    }
  }, {
    sequelize,
    modelName: 'Paciente',
    tableName: 'Pacientes',
    timestamps: true
  });
  return Paciente;
};
