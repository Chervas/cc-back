'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ClinicaHorario extends Model {
    static associate(models) {
      ClinicaHorario.belongsTo(models.Clinica, {
        foreignKey: 'clinica_id',
        targetKey: 'id_clinica',
        as: 'clinica'
      });
    }
  }

  ClinicaHorario.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    dia_semana: { type: DataTypes.INTEGER, allowNull: false },
    activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    hora_inicio: { type: DataTypes.STRING(5), allowNull: false },
    hora_fin: { type: DataTypes.STRING(5), allowNull: false }
  }, {
    sequelize,
    modelName: 'ClinicaHorario',
    tableName: 'ClinicaHorarios',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return ClinicaHorario;
};
