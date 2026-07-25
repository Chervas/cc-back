'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingCashClosure extends Model {}

  AccountingCashClosure.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    business_date: { type: DataTypes.DATEONLY, allowNull: false },
    opening_cash: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    cash_receipts: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    cash_outflows: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    expected_cash: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    actual_cash: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    denomination_breakdown: DataTypes.JSON,
    tender_reconciliation: DataTypes.JSON,
    difference: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    notes: { type: DataTypes.TEXT, allowNull: true },
    snapshot: { type: DataTypes.JSON, allowNull: false },
    closed_by: { type: DataTypes.INTEGER, allowNull: true },
    closed_at: { type: DataTypes.DATE, allowNull: false },
  }, {
    sequelize,
    modelName: 'AccountingCashClosure',
    tableName: 'AccountingCashClosures',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: false,
  });

  return AccountingCashClosure;
};
