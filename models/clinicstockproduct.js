'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicStockProduct', {
  id: { type: D.STRING(36), primaryKey: true }, clinic_id: { type: D.INTEGER, allowNull: false }, name: D.STRING(160), unit: D.STRING(40), location: D.STRING(160),
  supplier_id: D.STRING(36), minimum_quantity: D.DECIMAL(14, 3), quantity: D.DECIMAL(14, 3), active: D.BOOLEAN,
  version: D.INTEGER.UNSIGNED, created_by: D.INTEGER, updated_by: D.INTEGER,
}, { tableName: 'ClinicStockProducts', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
