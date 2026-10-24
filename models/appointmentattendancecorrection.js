'use strict';
module.exports = (sequelize, D) => sequelize.define('AppointmentAttendanceCorrection', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, appointment_id: D.INTEGER, clinic_id: D.INTEGER, actor_id: D.INTEGER,
  command_key: D.STRING(120), command_hash: D.STRING(64), reason: D.STRING(1000), snapshot: D.JSON,
}, { tableName: 'AppointmentAttendanceCorrections', underscored: true, createdAt: 'created_at', updatedAt: false, hooks: {
  beforeUpdate() { throw Error('attendance_correction_immutable'); }, beforeDestroy() { throw Error('attendance_correction_immutable'); },
  beforeBulkUpdate() { throw Error('attendance_correction_immutable'); }, beforeBulkDestroy() { throw Error('attendance_correction_immutable'); },
} });
