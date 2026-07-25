'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingRemittance extends Model {}
  AccountingRemittance.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    reference: { type: DataTypes.STRING(80), allowNull: false },
    requested_collection_date: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    creditor_snapshot: { type: DataTypes.JSON, allowNull: false },
    total_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    item_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    exported_at: DataTypes.DATE,
    created_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'AccountingRemittance',
    tableName: 'AccountingRemittances',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return AccountingRemittance;
};
