'use strict';
module.exports = (sequelize, D) => sequelize.define('BookingEquipmentClinic', {
  equipment_id: { type: D.INTEGER, primaryKey: true }, clinic_id: { type: D.INTEGER, primaryKey: true },
}, { tableName: 'BookingEquipmentClinics', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
