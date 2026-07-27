'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingExpenseDocument extends Model {}

  AccountingExpenseDocument.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    supplier_name: { type: DataTypes.STRING(180), allowNull: false },
    supplier_tax_id: { type: DataTypes.STRING(40), allowNull: true },
    supplier_address: { type: DataTypes.STRING(500), allowNull: true },
    document_number: { type: DataTypes.STRING(100), allowNull: false },
    issue_date: { type: DataTypes.DATEONLY, allowNull: false },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    category: { type: DataTypes.STRING(100), allowNull: false },
    payment_method: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'transfer' },
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'pending' },
    taxable_base: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    tax_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    withholding_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    total: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    paid_at: { type: DataTypes.DATE, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    attachment_asset_id: { type: DataTypes.INTEGER, allowNull: true },
    source_system: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'clinicaclick' },
    source_reference: { type: DataTypes.STRING(120), allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
    updated_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'AccountingExpenseDocument',
    tableName: 'AccountingExpenseDocuments',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return AccountingExpenseDocument;
};
