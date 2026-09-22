'use strict';
module.exports = (sequelize, D) => sequelize.define('BookingEquipmentRoomPolicy', {
  installation_id: { type: D.INTEGER, primaryKey: true }, mode: { type: D.STRING(12), allowNull: false, defaultValue: 'none' },
  equipment_ids: D.JSON, revision: { type: D.INTEGER, allowNull: false, defaultValue: 1 },
}, { tableName: 'BookingEquipmentRoomPolicies', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
