'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class DoctorHorario extends Model {
    static associate(models) {
      DoctorHorario.belongsTo(models.DoctorClinica, { foreignKey: 'doctor_clinica_id', as: 'doctorClinica' });
    }
  }
  DoctorHorario.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    doctor_clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    dia_semana: { type: DataTypes.INTEGER, allowNull: false },
    activo: { type: DataTypes.BOOLEAN, defaultValue: true },
    hora_inicio: { type: DataTypes.STRING(5), allowNull: false },
    hora_fin: { type: DataTypes.STRING(5), allowNull: false }
  }, {
    sequelize,
    modelName: 'DoctorHorario',
    tableName: 'DoctorHorarios',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });
  return DoctorHorario;
};
