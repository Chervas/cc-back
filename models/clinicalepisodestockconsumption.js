'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicalEpisodeStockConsumption', {
  id: { type: D.STRING(36), primaryKey: true }, clinic_id: { type: D.INTEGER, allowNull: false }, patient_id: { type: D.INTEGER, allowNull: false },
  report_id: { type: D.BIGINT.UNSIGNED, allowNull: false }, product_id: { type: D.STRING(36), allowNull: false }, movement_id: { type: D.STRING(36), allowNull: false },
  product_name: D.STRING(160), unit: D.STRING(40), quantity: D.DECIMAL(14, 3), episode_version: D.INTEGER.UNSIGNED, reason: D.STRING(500), actor_id: D.INTEGER,
}, { tableName: 'ClinicalEpisodeStockConsumptions', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at', hooks: {
  beforeUpdate() { throw Error('clinical_consumption_immutable'); }, beforeDestroy() { throw Error('clinical_consumption_immutable'); },
  beforeBulkUpdate() { throw Error('clinical_consumption_immutable'); }, beforeBulkDestroy() { throw Error('clinical_consumption_immutable'); },
} });
