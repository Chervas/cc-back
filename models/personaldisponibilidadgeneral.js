'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PersonalDisponibilidadGeneral extends Model {
    static associate(models) {
      PersonalDisponibilidadGeneral.belongsTo(models.Usuario, {
        foreignKey: 'doctor_id',
        targetKey: 'id_usuario',
        as: 'doctor',
      });
    }
  }

  PersonalDisponibilidadGeneral.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    doctor_id: { type: DataTypes.INTEGER, allowNull: false },
    dia_semana: { type: DataTypes.INTEGER, allowNull: false },
    activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    hora_inicio: { type: DataTypes.STRING(5), allowNull: false },
    hora_fin: { type: DataTypes.STRING(5), allowNull: false },
  }, {
    sequelize,
    modelName: 'PersonalDisponibilidadGeneral',
    tableName: 'PersonalDisponibilidadGenerales',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return PersonalDisponibilidadGeneral;
};

