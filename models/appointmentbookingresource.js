'use strict';
module.exports = (sequelize, DataTypes) => sequelize.define('AppointmentBookingResource', {
  resource_key: { type: DataTypes.STRING(80), primaryKey: true, allowNull: false },
  resource_kind: { type: DataTypes.STRING(20), allowNull: false },
}, { tableName: 'AppointmentBookingResources', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
