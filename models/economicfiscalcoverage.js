'use strict';
module.exports = (sequelize, D) => sequelize.define('EconomicFiscalCoverage', {
  id: { type: D.STRING(36), primaryKey: true }, clinic_id: D.INTEGER, patient_id: D.INTEGER, document_id: D.BIGINT.UNSIGNED,
  document_version: D.INTEGER.UNSIGNED, document_type: D.STRING(20), funding_key: D.STRING(160), source_kind: D.STRING(20),
  payment_id: D.BIGINT.UNSIGNED, wallet_entry_id: D.BIGINT.UNSIGNED, budget_id: D.BIGINT.UNSIGNED, budget_version: D.INTEGER.UNSIGNED, line_key: D.STRING(80),
  amount: D.DECIMAL(12, 2), taxable_base: D.DECIMAL(12, 2), tax_amount: D.DECIMAL(12, 2), status: D.STRING(16), actor_id: D.INTEGER, created_at: D.DATE,
}, { tableName: 'EconomicFiscalCoverages', timestamps: false });
