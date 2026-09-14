'use strict';
module.exports = (sequelize, DataTypes) => sequelize.define('PatientProgramSession', {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  voucher_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  session_key: { type: DataTypes.STRING(64), allowNull: false },
  position: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  snapshot_sha256: { type: DataTypes.STRING(64), allowNull: false },
  snapshot: { type: DataTypes.JSON, allowNull: false },
  appointment_id: { type: DataTypes.INTEGER, allowNull: true },
  consumption_movement_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
}, { tableName: 'PatientProgramSessions', createdAt: 'created_at', updatedAt: 'updated_at',
  indexes: [{ unique: true, fields: ['voucher_id', 'session_key'] }, { unique: true, fields: ['appointment_id'] }] });
