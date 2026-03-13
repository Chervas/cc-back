'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class DoctorHorarioExcepcion extends Model {
    static associate(models) {
      DoctorHorarioExcepcion.belongsTo(models.DoctorHorario, {
        foreignKey: 'doctor_horario_id',
        as: 'horario',
      });
    }
  }

  DoctorHorarioExcepcion.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    doctor_horario_id: { type: DataTypes.INTEGER, allowNull: false },
    fecha: { type: DataTypes.DATEONLY, allowNull: false },
    cancelado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    hora_inicio_override: { type: DataTypes.STRING(5), allowNull: true },
    hora_fin_override: { type: DataTypes.STRING(5), allowNull: true },
    creado_por: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'DoctorHorarioExcepcion',
    tableName: 'DoctorHorarioExcepciones',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return DoctorHorarioExcepcion;
};
