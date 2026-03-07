'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class DoctorHorario extends Model {
    static associate(models) {
      DoctorHorario.belongsTo(models.DoctorClinica, { foreignKey: 'doctor_clinica_id', as: 'doctorClinica' });
      DoctorHorario.hasMany(models.DoctorHorarioExcepcion, { foreignKey: 'doctor_horario_id', as: 'excepciones' });
    }
  }
  DoctorHorario.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    doctor_clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    dia_semana: { type: DataTypes.INTEGER, allowNull: false },
    activo: { type: DataTypes.BOOLEAN, defaultValue: true },
    hora_inicio: { type: DataTypes.STRING(5), allowNull: false },
    hora_fin: { type: DataTypes.STRING(5), allowNull: false },
    rrule: { type: DataTypes.STRING(255), allowNull: true },
    fecha_inicio_vigencia: { type: DataTypes.DATEONLY, allowNull: true },
    fecha_fin_vigencia: { type: DataTypes.DATEONLY, allowNull: true },
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
