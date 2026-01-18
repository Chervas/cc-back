'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PacienteClinica extends Model {
    static associate(models) {
      PacienteClinica.belongsTo(models.Paciente, { foreignKey: 'paciente_id', as: 'paciente' });
      PacienteClinica.belongsTo(models.Clinica, { foreignKey: 'clinica_id', as: 'clinica' });
    }
  }

  PacienteClinica.init({
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    paciente_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    clinica_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    es_principal: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    }
  }, {
    sequelize,
    modelName: 'PacienteClinica',
    tableName: 'PacienteClinicas',
    timestamps: true
  });

  return PacienteClinica;
};
