'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class EconomicBudget extends Model {}
  EconomicBudget.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    number: { type: DataTypes.STRING(50), allowNull: false },
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'draft' },
    current_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    valid_until: DataTypes.DATE,
    presented_at: DataTypes.DATE,
    responded_at: DataTypes.DATE,
    accepted_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    source_system: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'clinicaclick' },
    source_reference: DataTypes.STRING(120),
    created_by: DataTypes.INTEGER,
    updated_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'EconomicBudget',
    tableName: 'EconomicBudgets',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return EconomicBudget;
};
