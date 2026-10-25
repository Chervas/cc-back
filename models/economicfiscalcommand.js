'use strict';
module.exports = (sequelize, D) => sequelize.define('EconomicFiscalCommand', {
  id: { type: D.STRING(36), primaryKey: true }, clinic_id: D.INTEGER, patient_id: D.INTEGER, document_id: D.BIGINT.UNSIGNED,
  document_version: D.INTEGER.UNSIGNED, operation: D.STRING(20), idempotency_key: D.STRING(120), request_hash: D.STRING(64), snapshot: D.JSON, actor_id: D.INTEGER, created_at: D.DATE,
}, { tableName: 'EconomicFiscalCommands', timestamps: false, hooks: {
  beforeUpdate() { throw Error('economic_fiscal_command_immutable'); }, beforeDestroy() { throw Error('economic_fiscal_command_immutable'); },
  beforeBulkUpdate() { throw Error('economic_fiscal_command_immutable'); }, beforeBulkDestroy() { throw Error('economic_fiscal_command_immutable'); },
} });
