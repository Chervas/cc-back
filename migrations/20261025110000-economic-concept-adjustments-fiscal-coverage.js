'use strict';
// Selected additive release only. No backfill, repricing or historical document changes.
module.exports = {
  async up(q, S) {
    const tables = (await q.showAllTables()).map(row => typeof row === 'string' ? row : row.tableName || row.table_name);
    const ref = (model, key, type = S.BIGINT.UNSIGNED, nullable = false) => ({ type, allowNull: nullable, references: { model, key }, onDelete: 'RESTRICT' });
    const scoped = { clinic_id: ref('Clinicas', 'id_clinica', S.INTEGER), patient_id: ref('Pacientes', 'id_paciente', S.INTEGER) };
    if (!tables.includes('EconomicFundingParts')) await q.createTable('EconomicFundingParts', {
      id: { type: S.STRING(36), primaryKey: true }, ...scoped, budget_id: ref('EconomicBudgets', 'id', S.BIGINT.UNSIGNED, true),
      budget_version: S.INTEGER.UNSIGNED, line_key: S.STRING(80), funding_key: { type: S.STRING(160), allowNull: false },
      source_kind: { type: S.STRING(20), allowNull: false }, payment_id: ref('EconomicPayments', 'id', S.BIGINT.UNSIGNED, true),
      wallet_entry_id: ref('PatientWalletEntries', 'id', S.BIGINT.UNSIGNED, true), amount: { type: S.DECIMAL(12, 2), allowNull: false },
      taxable_base: { type: S.DECIMAL(12, 2), allowNull: false }, tax_amount: { type: S.DECIMAL(12, 2), allowNull: false },
      snapshot: { type: S.JSON, allowNull: false }, created_at: { type: S.DATE, allowNull: false },
    });
    if (!tables.includes('EconomicConceptAdjustments')) await q.createTable('EconomicConceptAdjustments', {
      id: { type: S.STRING(36), primaryKey: true }, ...scoped, budget_id: ref('EconomicBudgets', 'id'),
      budget_version: { type: S.INTEGER.UNSIGNED, allowNull: false }, line_key: { type: S.STRING(80), allowNull: false },
      concept_revision: { type: S.INTEGER.UNSIGNED, allowNull: false }, units: { type: S.DECIMAL(12, 2), allowNull: false },
      cancelled_amount: { type: S.DECIMAL(12, 2), allowNull: false }, refund_amount: { type: S.DECIMAL(12, 2), allowNull: false }, credited_amount: { type: S.DECIMAL(12, 2), allowNull: false },
      settlement: { type: S.STRING(20), allowNull: false }, refund_method: S.STRING(20), reason: { type: S.STRING(1000), allowNull: false },
      funding_allocations: { type: S.JSON, allowNull: false }, snapshot: { type: S.JSON, allowNull: false },
      wallet_entry_id: ref('PatientWalletEntries', 'id', S.BIGINT.UNSIGNED, true),
      idempotency_key: { type: S.STRING(120), allowNull: false }, request_hash: { type: S.STRING(64), allowNull: false }, actor_id: { type: S.INTEGER, allowNull: false },
      created_at: { type: S.DATE, allowNull: false },
    });
    if (!tables.includes('EconomicFiscalCoverages')) await q.createTable('EconomicFiscalCoverages', {
      id: { type: S.STRING(36), primaryKey: true }, ...scoped, document_id: ref('PatientFiscalDocuments', 'id'),
      document_version: { type: S.INTEGER.UNSIGNED, allowNull: false }, document_type: { type: S.STRING(20), allowNull: false },
      funding_key: { type: S.STRING(160), allowNull: false }, source_kind: { type: S.STRING(20), allowNull: false },
      payment_id: ref('EconomicPayments', 'id', S.BIGINT.UNSIGNED, true), wallet_entry_id: ref('PatientWalletEntries', 'id', S.BIGINT.UNSIGNED, true),
      budget_id: ref('EconomicBudgets', 'id', S.BIGINT.UNSIGNED, true), budget_version: S.INTEGER.UNSIGNED, line_key: S.STRING(80),
      amount: { type: S.DECIMAL(12, 2), allowNull: false }, taxable_base: { type: S.DECIMAL(12, 2), allowNull: false }, tax_amount: { type: S.DECIMAL(12, 2), allowNull: false },
      status: { type: S.STRING(16), allowNull: false }, actor_id: { type: S.INTEGER, allowNull: false }, created_at: { type: S.DATE, allowNull: false },
    });
    if (!tables.includes('EconomicFiscalCommands')) await q.createTable('EconomicFiscalCommands', {
      id: { type: S.STRING(36), primaryKey: true }, ...scoped, document_id: ref('PatientFiscalDocuments', 'id'),
      document_version: { type: S.INTEGER.UNSIGNED, allowNull: false }, operation: { type: S.STRING(20), allowNull: false },
      idempotency_key: { type: S.STRING(120), allowNull: false }, request_hash: { type: S.STRING(64), allowNull: false },
      snapshot: { type: S.JSON, allowNull: false }, actor_id: { type: S.INTEGER, allowNull: false }, created_at: { type: S.DATE, allowNull: false },
    });
    if (!tables.includes('EconomicFiscalCounters')) await q.createTable('EconomicFiscalCounters', {
      clinic_id: { ...ref('Clinicas', 'id_clinica', S.INTEGER), primaryKey: true },
      document_type: { type: S.STRING(20), allowNull: false, primaryKey: true }, series: { type: S.STRING(30), allowNull: false, primaryKey: true },
      fiscal_year: { type: S.INTEGER.UNSIGNED, allowNull: false, primaryKey: true }, sequence_number: { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    });
    const fields = await q.describeTable('PatientFiscalDocuments');
    if (!fields.version_number) await q.addColumn('PatientFiscalDocuments', 'version_number', { type: S.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 });
    if (!fields.rectifies_document_id) await q.addColumn('PatientFiscalDocuments', 'rectifies_document_id', ref('PatientFiscalDocuments', 'id', S.BIGINT.UNSIGNED, true));
    const indexes = [
      ['EconomicFundingParts', ['clinic_id', 'patient_id', 'funding_key'], 'economic_funding_part_once', true],
      ['EconomicFundingParts', ['budget_id', 'line_key'], 'economic_funding_concept'],
      ['EconomicConceptAdjustments', ['budget_id', 'line_key', 'concept_revision'], 'economic_concept_revision_once', true],
      ['EconomicConceptAdjustments', ['clinic_id', 'patient_id', 'idempotency_key'], 'economic_concept_command_once', true],
      ['EconomicFiscalCoverages', ['clinic_id', 'patient_id', 'funding_key', 'document_type', 'status'], 'economic_fiscal_coverage_funding'],
      ['EconomicFiscalCoverages', ['document_id', 'document_version'], 'economic_fiscal_document_coverage'],
      ['EconomicFiscalCommands', ['clinic_id', 'patient_id', 'idempotency_key'], 'economic_fiscal_command_once', true],
      ['EconomicFiscalCommands', ['document_id', 'document_version'], 'economic_fiscal_command_version', true],
    ];
    for (const [table, columns, name, unique = false] of indexes) if (!(await q.showIndex(table)).some(index => index.name === name)) await q.addIndex(table, columns, { name, unique });
  },
  async down() { throw Error('economic_history_preserved_rollback_code_only'); },
};
