'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class UsuarioClinica extends Model {
    static associate(models) {
      UsuarioClinica.belongsTo(models.Usuario, {
        foreignKey: 'id_usuario',
        targetKey: 'id_usuario',
        as: 'Usuario'
      });
      UsuarioClinica.belongsTo(models.Clinica, {
        foreignKey: 'id_clinica',
        targetKey: 'id_clinica',
        as: 'Clinica'
      });
      UsuarioClinica.belongsTo(models.Usuario, {
        foreignKey: 'invitado_por',
        targetKey: 'id_usuario',
        as: 'Invitador'
      });
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
      type: DataTypes.ENUM('Auxiliares y enfermeros', 'Doctores', 'Administrativos', 'Recepción / Comercial ventas'),
      allowNull: true,
      defaultValue: null
    },
    estado_invitacion: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'aceptada'
    },
    invitado_por: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    fecha_invitacion: {
      type: DataTypes.DATE,
      allowNull: true
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
