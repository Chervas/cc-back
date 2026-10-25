'use strict';
module.exports = (sequelize, D) => sequelize.define('EconomicFundingPart', {
  id: { type: D.STRING(36), primaryKey: true }, clinic_id: D.INTEGER, patient_id: D.INTEGER, budget_id: D.BIGINT.UNSIGNED,
  budget_version: D.INTEGER.UNSIGNED, line_key: D.STRING(80), funding_key: D.STRING(160), source_kind: D.STRING(20),
  payment_id: D.BIGINT.UNSIGNED, wallet_entry_id: D.BIGINT.UNSIGNED, amount: D.DECIMAL(12, 2), taxable_base: D.DECIMAL(12, 2), tax_amount: D.DECIMAL(12, 2), snapshot: D.JSON, created_at: D.DATE,
}, { tableName: 'EconomicFundingParts', timestamps: false, hooks: {
  beforeUpdate() { throw Error('economic_funding_part_immutable'); }, beforeDestroy() { throw Error('economic_funding_part_immutable'); },
  beforeBulkUpdate() { throw Error('economic_funding_part_immutable'); }, beforeBulkDestroy() { throw Error('economic_funding_part_immutable'); },
} });
