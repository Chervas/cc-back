'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Tratamiento extends Model {
    static associate(models) {
      if (models.Clinica) {
        Tratamiento.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      }
    }
  }

  Tratamiento.init({
    id_tratamiento: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    nombre: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    descripcion: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    disciplina: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    categoria: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    duracion_min: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    precio_base: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 0
    },
    color: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    activo: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    clinica_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    grupo_clinica_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'Tratamiento',
    tableName: 'Tratamientos',
    timestamps: true
  });

  return Tratamiento;
};
