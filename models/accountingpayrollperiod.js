'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingPayrollPeriod extends Model {}

  AccountingPayrollPeriod.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    period_month: { type: DataTypes.DATEONLY, allowNull: false },
    gross_salaries: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    employee_social_security: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    irpf_withholding: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    net_paid: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    employer_social_security: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    other_costs: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    total_personnel_cost: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    paid_at: { type: DataTypes.DATE, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    document_asset_id: { type: DataTypes.INTEGER, allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
    updated_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'AccountingPayrollPeriod',
    tableName: 'AccountingPayrollPeriods',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return AccountingPayrollPeriod;
};
