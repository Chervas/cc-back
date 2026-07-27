'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingPayrollDocument extends Model {}

  AccountingPayrollDocument.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    payroll_period_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    employee_id: { type: DataTypes.INTEGER, allowNull: true },
    employee_name: { type: DataTypes.STRING(180), allowNull: false },
    period_month: { type: DataTypes.DATEONLY, allowNull: false },
    gross_salary: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    employee_social_security: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    irpf_withholding: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    net_salary: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    other_amounts: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    match_status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'unmatched' },
    source_asset_id: { type: DataTypes.INTEGER, allowNull: false },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
    updated_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'AccountingPayrollDocument',
    tableName: 'AccountingPayrollDocuments',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return AccountingPayrollDocument;
};
