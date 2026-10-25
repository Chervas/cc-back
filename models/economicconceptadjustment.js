'use strict';
module.exports = (sequelize, D) => sequelize.define('EconomicConceptAdjustment', {
  id: { type: D.STRING(36), primaryKey: true }, clinic_id: D.INTEGER, patient_id: D.INTEGER, budget_id: D.BIGINT.UNSIGNED,
  budget_version: D.INTEGER.UNSIGNED, line_key: D.STRING(80), concept_revision: D.INTEGER.UNSIGNED, units: D.DECIMAL(12, 2),
  cancelled_amount: D.DECIMAL(12, 2), refund_amount: D.DECIMAL(12, 2), credited_amount: D.DECIMAL(12, 2), settlement: D.STRING(20), refund_method: D.STRING(20), reason: D.STRING(1000),
  funding_allocations: D.JSON, snapshot: D.JSON, wallet_entry_id: D.BIGINT.UNSIGNED, idempotency_key: D.STRING(120), request_hash: D.STRING(64), actor_id: D.INTEGER, created_at: D.DATE,
}, { tableName: 'EconomicConceptAdjustments', timestamps: false, hooks: {
  beforeUpdate() { throw Error('economic_concept_adjustment_immutable'); }, beforeDestroy() { throw Error('economic_concept_adjustment_immutable'); },
  beforeBulkUpdate() { throw Error('economic_concept_adjustment_immutable'); }, beforeBulkDestroy() { throw Error('economic_concept_adjustment_immutable'); },
} });
