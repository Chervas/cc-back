'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicStockMovement', {
  id: { type: D.STRING(36), primaryKey: true }, clinic_id: { type: D.INTEGER, allowNull: false }, product_id: D.STRING(36), order_id: D.STRING(36),
  kind: D.STRING(24), quantity: D.DECIMAL(14, 3), quantity_after: D.DECIMAL(14, 3), reason: D.STRING(500), actor_id: D.INTEGER,
}, { tableName: 'ClinicStockMovements', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at', hooks: {
  beforeUpdate() { throw Error('clinic_stock_movement_immutable'); }, beforeDestroy() { throw Error('clinic_stock_movement_immutable'); },
  beforeBulkUpdate() { throw Error('clinic_stock_movement_immutable'); }, beforeBulkDestroy() { throw Error('clinic_stock_movement_immutable'); },
} });
