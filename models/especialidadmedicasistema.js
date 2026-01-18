'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class EspecialidadesMedicasSistema extends Model {
    static associate(models) {
      // No extra associations for now
    }
  }
  EspecialidadesMedicasSistema.init({
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    nombre: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    disciplina: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    activo: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    }
  }, {
    sequelize,
    modelName: 'EspecialidadesMedicasSistema',
    tableName: 'EspecialidadesMedicasSistema',
    timestamps: true
  });
  return EspecialidadesMedicasSistema;
};
