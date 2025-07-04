'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Paciente extends Model {
    static associate(models) {
      // Cada paciente pertenece a una clínica
      Paciente.belongsTo(models.Clinica, { foreignKey: 'clinica_id', as: 'clinica' });
    }
  }
  Paciente.init({
    id_paciente: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
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
      allowNull: false
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
