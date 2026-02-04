'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class DoctorBloqueo extends Model {
    static associate(models) {
      DoctorBloqueo.belongsTo(models.Usuario, { foreignKey: 'doctor_id', targetKey: 'id_usuario', as: 'doctor' });
    }
  }
  DoctorBloqueo.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    doctor_id: { type: DataTypes.INTEGER, allowNull: false },
    fecha_inicio: { type: DataTypes.DATE, allowNull: false },
    fecha_fin: { type: DataTypes.DATE, allowNull: false },
    motivo: DataTypes.STRING(255),
    recurrente: { type: DataTypes.ENUM('none','daily','weekly','monthly'), defaultValue: 'none' },
    aplica_a_todas_clinicas: { type: DataTypes.BOOLEAN, defaultValue: false },
    creado_por: DataTypes.INTEGER
  }, {
    sequelize,
    modelName: 'DoctorBloqueo',
    tableName: 'DoctorBloqueos',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });
  return DoctorBloqueo;
};
