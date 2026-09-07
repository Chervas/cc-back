'use strict';
module.exports = (sequelize, DataTypes) => {
  const model = sequelize.define('AppointmentBookingOccupancy', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    appointment_id: { type: DataTypes.INTEGER, allowNull: false },
    phase_key: { type: DataTypes.STRING(64), allowNull: false },
    resource_kind: { type: DataTypes.STRING(20), allowNull: false },
    resource_key: { type: DataTypes.STRING(80), allowNull: false },
    installation_id: { type: DataTypes.INTEGER, allowNull: true },
    doctor_id: { type: DataTypes.INTEGER, allowNull: true },
    start_at: { type: DataTypes.DATE, allowNull: false },
    end_at: { type: DataTypes.DATE, allowNull: false },
  }, { tableName: 'AppointmentBookingOccupancies', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
  model.associate = (models) => model.belongsTo(models.CitaPaciente, { foreignKey: 'appointment_id', as: 'appointment' });
  return model;
};
