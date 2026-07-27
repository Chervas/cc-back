'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class EconomicBudgetVersion extends Model {}
  EconomicBudgetVersion.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    budget_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    version_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    lines: { type: DataTypes.JSON, allowNull: false },
    totals: { type: DataTypes.JSON, allowNull: false },
    payment_proposal: { type: DataTypes.JSON, allowNull: false },
    design_config: { type: DataTypes.JSON, allowNull: false },
    clinic_snapshot: { type: DataTypes.JSON, allowNull: false },
    patient_snapshot: { type: DataTypes.JSON, allowNull: false },
    notes: DataTypes.TEXT,
    internal_notes: DataTypes.TEXT,
    change_summary: DataTypes.STRING(255),
    created_by: DataTypes.INTEGER,
    created_at: DataTypes.DATE,
  }, {
    sequelize,
    modelName: 'EconomicBudgetVersion',
    tableName: 'EconomicBudgetVersions',
    timestamps: false,
  });
  return EconomicBudgetVersion;
};
