'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('AccountingIngestionJobs', 'document_kind', {
      type: Sequelize.STRING(20),
      allowNull: false,
      defaultValue: 'expense',
      after: 'clinic_id',
    });
    await queryInterface.addColumn('AccountingIngestionJobs', 'payroll_document_id', {
      type: Sequelize.BIGINT.UNSIGNED,
      allowNull: true,
      after: 'expense_document_id',
    });
    await queryInterface.addIndex('AccountingIngestionJobs', ['clinic_id', 'document_kind', 'status'], {
      name: 'accounting_ingestion_jobs_kind_status_idx',
    });

    await queryInterface.createTable('AccountingPayrollDocuments', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onDelete: 'CASCADE',
      },
      payroll_period_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'AccountingPayrollPeriods', key: 'id' },
        onDelete: 'SET NULL',
      },
      employee_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onDelete: 'SET NULL',
      },
      employee_name: { type: Sequelize.STRING(180), allowNull: false },
      period_month: { type: Sequelize.DATEONLY, allowNull: false },
      gross_salary: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      employee_social_security: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      irpf_withholding: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      net_salary: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      other_amounts: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      match_status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'unmatched' },
      source_asset_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'ClinicalPrivateAssets', key: 'id' },
        onDelete: 'RESTRICT',
      },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      updated_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AccountingPayrollDocuments', ['clinic_id', 'period_month'], {
      name: 'accounting_payroll_documents_period_idx',
    });
    await queryInterface.addIndex('AccountingPayrollDocuments', ['clinic_id', 'match_status'], {
      name: 'accounting_payroll_documents_match_idx',
    });
    await queryInterface.addIndex('AccountingPayrollDocuments', ['employee_id', 'period_month'], {
      name: 'accounting_payroll_documents_employee_idx',
    });
    await queryInterface.addIndex('AccountingPayrollDocuments', ['source_asset_id'], {
      name: 'accounting_payroll_documents_asset_idx',
      unique: true,
    });

    await queryInterface.addConstraint('AccountingIngestionJobs', {
      fields: ['payroll_document_id'],
      type: 'foreign key',
      name: 'accounting_ingestion_jobs_payroll_document_fk',
      references: {
        table: 'AccountingPayrollDocuments',
        field: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeConstraint(
      'AccountingIngestionJobs',
      'accounting_ingestion_jobs_payroll_document_fk',
    );
    await queryInterface.dropTable('AccountingPayrollDocuments');
    await queryInterface.removeIndex(
      'AccountingIngestionJobs',
      'accounting_ingestion_jobs_kind_status_idx',
    );
    await queryInterface.removeColumn('AccountingIngestionJobs', 'payroll_document_id');
    await queryInterface.removeColumn('AccountingIngestionJobs', 'document_kind');
  },
};
