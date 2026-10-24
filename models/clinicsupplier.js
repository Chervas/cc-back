'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicSupplier', {
  id: { type: D.STRING(36), primaryKey: true }, clinic_id: { type: D.INTEGER, allowNull: false }, name: { type: D.STRING(160), allowNull: false },
  type: { type: D.STRING(24), allowNull: false }, contact_name: D.STRING(160), email: D.STRING(254), phone: D.STRING(60), notes: D.TEXT,
  active: D.BOOLEAN, version: D.INTEGER.UNSIGNED, created_by: D.INTEGER, updated_by: D.INTEGER,
}, { tableName: 'ClinicSuppliers', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
