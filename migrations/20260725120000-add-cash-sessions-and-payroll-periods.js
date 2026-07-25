'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('AccountingCashSessions', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onDelete: 'CASCADE',
      },
      business_date: { type: Sequelize.DATEONLY, allowNull: false },
      opening_cash: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      suggested_opening_cash: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'open' },
      closure_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
        references: { model: 'AccountingCashClosures', key: 'id' },
        onDelete: 'SET NULL',
      },
      notes: { type: Sequelize.TEXT, allowNull: true },
      opened_by: { type: Sequelize.INTEGER, allowNull: true },
      opened_at: { type: Sequelize.DATE, allowNull: false },
      closed_by: { type: Sequelize.INTEGER, allowNull: true },
      closed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AccountingCashSessions', ['clinic_id', 'business_date'], {
      name: 'accounting_cash_sessions_clinic_date_uq',
      unique: true,
    });
    await queryInterface.addIndex('AccountingCashSessions', ['clinic_id', 'status', 'business_date'], {
      name: 'accounting_cash_sessions_status_idx',
    });
    await queryInterface.sequelize.query(`
      INSERT INTO AccountingCashSessions (
        public_id,
        clinic_id,
        business_date,
        opening_cash,
        suggested_opening_cash,
        status,
        closure_id,
        notes,
        opened_by,
        opened_at,
        closed_by,
        closed_at,
        created_at,
        updated_at
      )
      SELECT
        UUID(),
        clinic_id,
        business_date,
        opening_cash,
        opening_cash,
        'closed',
        id,
        notes,
        closed_by,
        closed_at,
        closed_by,
        closed_at,
        created_at,
        created_at
      FROM AccountingCashClosures
    `);

    await queryInterface.createTable('AccountingPayrollPeriods', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      public_id: { type: Sequelize.STRING(36), allowNull: false, unique: true },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onDelete: 'CASCADE',
      },
      period_month: { type: Sequelize.DATEONLY, allowNull: false },
      gross_salaries: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      employee_social_security: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      irpf_withholding: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      net_paid: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      employer_social_security: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      other_costs: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      total_personnel_cost: { type: Sequelize.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'draft' },
      paid_at: { type: Sequelize.DATE, allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      document_asset_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'ClinicalPrivateAssets', key: 'id' },
        onDelete: 'SET NULL',
      },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      updated_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
    });
    await queryInterface.addIndex('AccountingPayrollPeriods', ['clinic_id', 'period_month'], {
      name: 'accounting_payroll_periods_clinic_month_uq',
      unique: true,
    });
    await queryInterface.addIndex('AccountingPayrollPeriods', ['clinic_id', 'status', 'period_month'], {
      name: 'accounting_payroll_periods_status_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('AccountingPayrollPeriods');
    await queryInterface.dropTable('AccountingCashSessions');
  },
};
