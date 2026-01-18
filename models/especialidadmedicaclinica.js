'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class EspecialidadesMedicasClinica extends Model {
    static associate(models) {
      if (models.Clinica) {
        EspecialidadesMedicasClinica.belongsTo(models.Clinica, { foreignKey: 'id_clinica', targetKey: 'id_clinica', as: 'clinica' });
      }
    }
  }
  EspecialidadesMedicasClinica.init({
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    id_clinica: {
      type: DataTypes.INTEGER,
      allowNull: false
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
    modelName: 'EspecialidadesMedicasClinica',
    tableName: 'EspecialidadesMedicasClinica',
    timestamps: true
  });
  return EspecialidadesMedicasClinica;
};
