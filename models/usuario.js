'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Usuario extends Model {
    static associate(models) {
      // Asociación muchos a muchos con Clinica a través de UsuarioClinica
      Usuario.belongsToMany(models.Clinica, {
        through: models.UsuarioClinica,
        foreignKey: 'id_usuario',
        otherKey: 'id_clinica',
        as: 'Clinicas'
      });
    }
  }

  Usuario.init({
    id_usuario: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    nombre: {
      type: DataTypes.STRING,
      allowNull: false
    },
    apellidos: DataTypes.STRING,
    email_usuario: DataTypes.STRING,
    email_factura: DataTypes.STRING,
    email_notificacion: DataTypes.STRING,
    password_usuario: DataTypes.STRING,
    fecha_creacion: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    id_gestor: DataTypes.INTEGER,
    notas_usuario: DataTypes.STRING,
    telefono: DataTypes.STRING,
    cargo_usuario: DataTypes.STRING,
    cumpleanos: DataTypes.DATE,
    isProfesional: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    }
  }, {
    sequelize,
    modelName: 'Usuario',
    tableName: 'Usuarios',
    timestamps: true
  });

  return Usuario;
};
