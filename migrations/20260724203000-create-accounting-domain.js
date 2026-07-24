'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('UsuarioClinica', 'subrol_clinica', {
      type: Sequelize.ENUM(
        'Auxiliares y enfermeros',
        'Doctores',
        'Administrativos',
        'Recepción / Comercial ventas',
        'Gestoría'
      ),
      allowNull: true,
      defaultValue: null,
    });

    await queryInterface.createTable('AccountingExpenseDocuments', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      supplier_name: { type: Sequelize.STRING(180), allowNull: false },
      supplier_tax_id: { type: Sequelize.STRING(40), allowNull: true },
      supplier_address: { type: Sequelize.STRING(500), allowNull: true },
      document_number: { type: Sequelize.STRING(100), allowNull: false },
      issue_date: { type: Sequelize.DATEONLY, allowNull: false },
      due_date: { type: Sequelize.DATEONLY, allowNull: true },
      category: { type: Sequelize.STRING(100), allowNull: false },
      payment_method: {
        type: Sequelize.ENUM('cash', 'card', 'transfer', 'direct_debit', 'other'),
        allowNull: false,
        defaultValue: 'transfer',
      },
      status: {
        type: Sequelize.ENUM('pending', 'paid', 'cancelled'),
        allowNull: false,
        defaultValue: 'pending',
      },
      taxable_base: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      tax_amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      withholding_amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      total: { type: Sequelize.DECIMAL(12, 2), allowNull: false },
      paid_at: { type: Sequelize.DATE, allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      attachment_asset_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ClinicalPrivateAssets', key: 'id' },
        onDelete: 'SET NULL',
      },
      source_system: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'clinicaclick' },
      source_reference: { type: Sequelize.STRING(120), allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      updated_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AccountingExpenseDocuments', ['clinic_id', 'issue_date', 'status'], {
      name: 'accounting_expenses_clinic_period_idx',
    });
    await queryInterface.addIndex('AccountingExpenseDocuments', ['clinic_id', 'supplier_tax_id', 'document_number'], {
      name: 'accounting_expenses_supplier_document_uq',
      unique: true,
    });

    await queryInterface.createTable('AccountingCashMovements', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      movement_type: {
        type: Sequelize.ENUM('income', 'expense', 'adjustment'),
        allowNull: false,
      },
      amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false },
      method: {
        type: Sequelize.ENUM('cash', 'card', 'transfer', 'bizum', 'other'),
        allowNull: false,
        defaultValue: 'cash',
      },
      description: { type: Sequelize.STRING(255), allowNull: false },
      source_type: { type: Sequelize.STRING(60), allowNull: true },
      source_id: { type: Sequelize.STRING(80), allowNull: true },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AccountingCashMovements', ['clinic_id', 'occurred_at', 'method'], {
      name: 'accounting_cash_movements_period_idx',
    });

    await queryInterface.createTable('AccountingCashClosures', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
      },
      business_date: { type: Sequelize.DATEONLY, allowNull: false },
      opening_cash: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      cash_receipts: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      cash_outflows: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      expected_cash: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      actual_cash: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      difference: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      notes: { type: Sequelize.TEXT, allowNull: true },
      snapshot: { type: Sequelize.JSON, allowNull: false },
      closed_by: { type: Sequelize.INTEGER, allowNull: true },
      closed_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AccountingCashClosures', ['clinic_id', 'business_date'], {
      name: 'accounting_cash_closures_date_uq',
      unique: true,
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('AccountingCashClosures');
    await queryInterface.dropTable('AccountingCashMovements');
    await queryInterface.dropTable('AccountingExpenseDocuments');
    await queryInterface.changeColumn('UsuarioClinica', 'subrol_clinica', {
      type: Sequelize.ENUM(
        'Auxiliares y enfermeros',
        'Doctores',
        'Administrativos',
        'Recepción / Comercial ventas'
      ),
      allowNull: true,
      defaultValue: null,
    });
  },
};
