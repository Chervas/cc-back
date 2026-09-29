'use strict';
module.exports = (sequelize, D) => sequelize.define('AppointmentCareEvent', {
  id: { type: D.INTEGER, primaryKey: true, autoIncrement: true },
  appointment_id: { type: D.INTEGER, allowNull: false },
  clinic_id: { type: D.INTEGER, allowNull: false },
  actor_id: { type: D.INTEGER, allowNull: false },
  action: { type: D.STRING(20), allowNull: false },
  schedule_start: { type: D.DATE, allowNull: false },
  created_at: { type: D.DATE, allowNull: false },
}, { tableName: 'AppointmentCareEvents', timestamps: false });
