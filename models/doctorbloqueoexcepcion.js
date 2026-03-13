'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class DoctorBloqueoExcepcion extends Model {
    static associate(models) {
      DoctorBloqueoExcepcion.belongsTo(models.DoctorBloqueo, {
        foreignKey: 'doctor_bloqueo_id',
        as: 'bloqueo',
      });
    }
  }

  DoctorBloqueoExcepcion.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    doctor_bloqueo_id: { type: DataTypes.INTEGER, allowNull: false },
    fecha: { type: DataTypes.DATEONLY, allowNull: false },
    cancelado: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    creado_por: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'DoctorBloqueoExcepcion',
    tableName: 'DoctorBloqueoExcepciones',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return DoctorBloqueoExcepcion;
};
