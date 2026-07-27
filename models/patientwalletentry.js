'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientWalletEntry extends Model {}
  PatientWalletEntry.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    payment_id: DataTypes.BIGINT.UNSIGNED,
    budget_id: DataTypes.BIGINT.UNSIGNED,
    entry_type: { type: DataTypes.STRING(20), allowNull: false },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'confirmed' },
    reference: DataTypes.STRING(120),
    notes: DataTypes.TEXT,
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    created_by: DataTypes.INTEGER,
    created_at: DataTypes.DATE,
  }, {
    sequelize,
    modelName: 'PatientWalletEntry',
    tableName: 'PatientWalletEntries',
    timestamps: false,
  });
  return PatientWalletEntry;
};
