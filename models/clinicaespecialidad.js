'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ClinicaEspecialidades extends Model {
    static associate(models) {
      if (models.Clinica) {
        ClinicaEspecialidades.belongsTo(models.Clinica, { foreignKey: 'id_clinica', targetKey: 'id_clinica', as: 'clinica' });
      }
      if (models.EspecialidadesMedicasSistema) {
        ClinicaEspecialidades.belongsTo(models.EspecialidadesMedicasSistema, { foreignKey: 'id_especialidad_sistema', as: 'especialidadSistema' });
      }
      if (models.EspecialidadesMedicasClinica) {
        ClinicaEspecialidades.belongsTo(models.EspecialidadesMedicasClinica, { foreignKey: 'id_especialidad_clinica', as: 'especialidadClinica' });
      }
    }
  }

  ClinicaEspecialidades.init({
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    id_clinica: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    id_especialidad_sistema: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    id_especialidad_clinica: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    origen: {
      type: DataTypes.ENUM('sistema', 'clinica'),
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'ClinicaEspecialidades',
    tableName: 'ClinicaEspecialidades',
    timestamps: true
  });

  return ClinicaEspecialidades;
};
