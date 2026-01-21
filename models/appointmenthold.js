'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AppointmentHold extends Model {
    static associate(models) {
      if (models.LeadIntake) {
        AppointmentHold.belongsTo(models.LeadIntake, { foreignKey: 'lead_intake_id', as: 'lead' });
      }
      if (models.Clinica) {
        AppointmentHold.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      }
      if (models.Usuario) {
        AppointmentHold.belongsTo(models.Usuario, { foreignKey: 'doctor_id', targetKey: 'id_usuario', as: 'doctor' });
      }
    }
  }

  AppointmentHold.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    lead_intake_id: { type: DataTypes.INTEGER, allowNull: true },
    doctor_id: { type: DataTypes.INTEGER, allowNull: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    inicio: { type: DataTypes.DATE, allowNull: false },
    fin: { type: DataTypes.DATE, allowNull: false },
    estado: {
      type: DataTypes.ENUM('propuesto', 'confirmado', 'expirado', 'cancelado'),
      allowNull: false,
      defaultValue: 'propuesto'
    },
    motivo: { type: DataTypes.TEXT, allowNull: true }
  }, {
    sequelize,
    modelName: 'AppointmentHold',
    tableName: 'AppointmentHolds',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return AppointmentHold;
};
