'use strict';
module.exports = (sequelize, DataTypes) => sequelize.define('PatientProgramBookingRequest', {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  voucher_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  request_key: { type: DataTypes.STRING(80), allowNull: false },
  request_sha256: { type: DataTypes.STRING(64), allowNull: false },
  result: { type: DataTypes.JSON, allowNull: false },
  created_by: { type: DataTypes.INTEGER, allowNull: false },
}, { tableName: 'PatientProgramBookingRequests', createdAt: 'created_at', updatedAt: false,
  indexes: [{ unique: true, fields: ['voucher_id', 'request_key'] }] });
