'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class EconomicPayment extends Model {}
  EconomicPayment.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    budget_id: DataTypes.BIGINT.UNSIGNED,
    budget_version: DataTypes.INTEGER.UNSIGNED,
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    method: { type: DataTypes.STRING(20), allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'confirmed' },
    reference: DataTypes.STRING(120),
    application: { type: DataTypes.JSON, allowNull: false },
    notes: DataTypes.TEXT,
    paid_at: { type: DataTypes.DATE, allowNull: false },
    created_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'EconomicPayment',
    tableName: 'EconomicPayments',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return EconomicPayment;
};
