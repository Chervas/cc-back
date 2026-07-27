'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('EconomicBudgets', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      patient_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
      },
      number: { type: Sequelize.STRING(50), allowNull: false },
      status: {
        type: Sequelize.ENUM('draft', 'presented', 'accepted', 'partially_accepted', 'rejected', 'expired', 'superseded'),
        allowNull: false,
        defaultValue: 'draft',
      },
      current_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      valid_until: { type: Sequelize.DATE, allowNull: true },
      presented_at: { type: Sequelize.DATE, allowNull: true },
      responded_at: { type: Sequelize.DATE, allowNull: true },
      accepted_amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      source_system: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'clinicaclick' },
      source_reference: { type: Sequelize.STRING(120), allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      updated_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('EconomicBudgets', ['clinic_id', 'patient_id', 'status'], {
      name: 'economic_budgets_patient_status_idx',
    });
    await queryInterface.addIndex('EconomicBudgets', ['clinic_id', 'number'], {
      name: 'economic_budgets_clinic_number_uq',
      unique: true,
    });
    await queryInterface.addIndex('EconomicBudgets', ['clinic_id', 'source_system', 'source_reference'], {
      name: 'economic_budgets_import_ref_uq',
      unique: true,
    });

    await queryInterface.createTable('EconomicBudgetVersions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      budget_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'EconomicBudgets', key: 'id' },
        onDelete: 'CASCADE',
      },
      version_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      lines: { type: Sequelize.JSON, allowNull: false },
      totals: { type: Sequelize.JSON, allowNull: false },
      payment_proposal: { type: Sequelize.JSON, allowNull: false },
      design_config: { type: Sequelize.JSON, allowNull: false },
      clinic_snapshot: { type: Sequelize.JSON, allowNull: false },
      patient_snapshot: { type: Sequelize.JSON, allowNull: false },
      notes: { type: Sequelize.TEXT, allowNull: true },
      internal_notes: { type: Sequelize.TEXT, allowNull: true },
      change_summary: { type: Sequelize.STRING(255), allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('EconomicBudgetVersions', ['budget_id', 'version_number'], {
      name: 'economic_budget_versions_number_uq',
      unique: true,
    });

    await queryInterface.createTable('EconomicBudgetEvents', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      budget_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'EconomicBudgets', key: 'id' },
        onDelete: 'CASCADE',
      },
      version_number: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      event_type: {
        type: Sequelize.ENUM('created', 'edited', 'presented', 'accepted', 'partially_accepted', 'rejected', 'expired', 'duplicated', 'superseded'),
        allowNull: false,
      },
      from_status: { type: Sequelize.STRING(30), allowNull: true },
      to_status: { type: Sequelize.STRING(30), allowNull: false },
      metadata: { type: Sequelize.JSON, allowNull: true },
      actor_id: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('EconomicBudgetEvents', ['budget_id', 'created_at'], {
      name: 'economic_budget_events_timeline_idx',
    });

    await queryInterface.createTable('ClinicEconomicTemplates', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      template_type: { type: Sequelize.ENUM('budget', 'invoice'), allowNull: false },
      name: { type: Sequelize.STRING(120), allowNull: false },
      area_code: { type: Sequelize.STRING(50), allowNull: true },
      config: { type: Sequelize.JSON, allowNull: false },
      is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      updated_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('ClinicEconomicTemplates', ['clinic_id', 'template_type', 'active'], {
      name: 'clinic_economic_templates_scope_idx',
    });

    await queryInterface.createTable('EconomicPayments', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      patient_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
      },
      budget_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'EconomicBudgets', key: 'id' },
        onDelete: 'SET NULL',
      },
      budget_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false },
      method: {
        type: Sequelize.ENUM('cash', 'card', 'transfer', 'bizum', 'financing', 'insurance', 'other'),
        allowNull: false,
      },
      status: { type: Sequelize.ENUM('confirmed', 'voided', 'refunded'), allowNull: false, defaultValue: 'confirmed' },
      reference: { type: Sequelize.STRING(120), allowNull: true },
      application: { type: Sequelize.JSON, allowNull: false },
      notes: { type: Sequelize.TEXT, allowNull: true },
      paid_at: { type: Sequelize.DATE, allowNull: false },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('EconomicPayments', ['clinic_id', 'patient_id', 'paid_at'], {
      name: 'economic_payments_patient_timeline_idx',
    });
    await queryInterface.addIndex('EconomicPayments', ['budget_id', 'status'], {
      name: 'economic_payments_budget_status_idx',
    });

    await queryInterface.createTable('PatientWalletEntries', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      patient_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
      },
      payment_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'EconomicPayments', key: 'id' },
        onDelete: 'SET NULL',
      },
      budget_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'EconomicBudgets', key: 'id' },
        onDelete: 'SET NULL',
      },
      entry_type: {
        type: Sequelize.ENUM('deposit', 'overpayment', 'allocation', 'refund', 'adjustment'),
        allowNull: false,
      },
      amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false },
      status: { type: Sequelize.ENUM('confirmed', 'voided'), allowNull: false, defaultValue: 'confirmed' },
      reference: { type: Sequelize.STRING(120), allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('PatientWalletEntries', ['clinic_id', 'patient_id', 'status', 'occurred_at'], {
      name: 'patient_wallet_entries_balance_idx',
    });

    await queryInterface.createTable('PatientVouchers', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      patient_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
      },
      budget_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'EconomicBudgets', key: 'id' },
        onDelete: 'SET NULL',
      },
      budget_line_key: { type: Sequelize.STRING(80), allowNull: true },
      treatment_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Tratamientos', key: 'id_tratamiento' },
        onDelete: 'SET NULL',
      },
      name: { type: Sequelize.STRING(180), allowNull: false },
      unit_label: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'sesiones' },
      total_units: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      available_units: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      sold_amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false },
      activation_rule: {
        type: Sequelize.ENUM('on_acceptance', 'on_first_payment', 'on_full_payment', 'manual'),
        allowNull: false,
        defaultValue: 'on_first_payment',
      },
      status: { type: Sequelize.ENUM('pending', 'active', 'consumed', 'expired', 'cancelled'), allowNull: false },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      source_system: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'clinicaclick' },
      source_reference: { type: Sequelize.STRING(120), allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('PatientVouchers', ['clinic_id', 'patient_id', 'status'], {
      name: 'patient_vouchers_patient_status_idx',
    });
    await queryInterface.addIndex('PatientVouchers', ['clinic_id', 'source_system', 'source_reference'], {
      name: 'patient_vouchers_import_ref_uq',
      unique: true,
    });

    await queryInterface.createTable('PatientVoucherMovements', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      voucher_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'PatientVouchers', key: 'id' },
        onDelete: 'CASCADE',
      },
      movement_type: { type: Sequelize.ENUM('activation', 'consumption', 'refund', 'adjustment', 'expiry'), allowNull: false },
      units: { type: Sequelize.DECIMAL(10, 2), allowNull: false },
      appointment_id: { type: Sequelize.INTEGER, allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('PatientVoucherMovements', ['voucher_id', 'occurred_at'], {
      name: 'patient_voucher_movements_timeline_idx',
    });

    await queryInterface.createTable('PatientFiscalDocuments', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      patient_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Pacientes', key: 'id_paciente' },
      },
      budget_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'EconomicBudgets', key: 'id' },
        onDelete: 'SET NULL',
      },
      payment_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'EconomicPayments', key: 'id' },
        onDelete: 'SET NULL',
      },
      document_type: { type: Sequelize.ENUM('receipt', 'invoice', 'credit_note'), allowNull: false },
      series: { type: Sequelize.STRING(30), allowNull: false },
      number: { type: Sequelize.STRING(60), allowNull: false },
      status: { type: Sequelize.ENUM('draft', 'issued', 'voided'), allowNull: false, defaultValue: 'draft' },
      issue_date: { type: Sequelize.DATE, allowNull: false },
      due_date: { type: Sequelize.DATE, allowNull: true },
      issuer_snapshot: { type: Sequelize.JSON, allowNull: false },
      recipient_snapshot: { type: Sequelize.JSON, allowNull: false },
      lines: { type: Sequelize.JSON, allowNull: false },
      totals: { type: Sequelize.JSON, allowNull: false },
      payment_data: { type: Sequelize.JSON, allowNull: true },
      template_snapshot: { type: Sequelize.JSON, allowNull: false },
      verifactu_status: {
        type: Sequelize.ENUM('mock_pending', 'ready', 'submitted', 'accepted', 'rejected', 'not_applicable'),
        allowNull: false,
        defaultValue: 'mock_pending',
      },
      notes: { type: Sequelize.TEXT, allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      updated_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('PatientFiscalDocuments', ['clinic_id', 'document_type', 'series', 'number'], {
      name: 'patient_fiscal_documents_number_uq',
      unique: true,
    });
    await queryInterface.addIndex('PatientFiscalDocuments', ['clinic_id', 'patient_id', 'issue_date'], {
      name: 'patient_fiscal_documents_patient_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('PatientFiscalDocuments');
    await queryInterface.dropTable('PatientVoucherMovements');
    await queryInterface.dropTable('PatientVouchers');
    await queryInterface.dropTable('PatientWalletEntries');
    await queryInterface.dropTable('EconomicPayments');
    await queryInterface.dropTable('ClinicEconomicTemplates');
    await queryInterface.dropTable('EconomicBudgetEvents');
    await queryInterface.dropTable('EconomicBudgetVersions');
    await queryInterface.dropTable('EconomicBudgets');
  },
};
