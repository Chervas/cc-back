'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class UsuarioClinica extends Model {
    static associate(models) {
      // Define asociaciones si es necesario
    }
  }
  UsuarioClinica.init({
    id_usuario: {
      type: DataTypes.INTEGER,
      primaryKey: true,
    },
    id_clinica: {
      type: DataTypes.INTEGER,
      primaryKey: true,
    },
    // Rol principal: 'paciente', 'personaldeclinica' o 'propietario'
    rol_clinica: {
      type: DataTypes.ENUM('paciente', 'personaldeclinica', 'propietario'),
      allowNull: false,
      defaultValue: 'paciente'
    },
    // Subrol: 'Auxiliares y enfermeros', 'Doctores' o 'Administrativos'
    subrol_clinica: {
      type: DataTypes.ENUM('Auxiliares y enfermeros', 'Doctores', 'Administrativos'),
      allowNull: true,
      defaultValue: null
    },
    datos_fiscales_clinica: {
      type: DataTypes.JSON,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'UsuarioClinica',
    tableName: 'UsuarioClinica',
    timestamps: true
  });
  return UsuarioClinica;
};
