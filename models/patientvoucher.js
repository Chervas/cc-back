'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientVoucher extends Model {}
  PatientVoucher.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    budget_id: DataTypes.BIGINT.UNSIGNED,
    budget_line_key: DataTypes.STRING(80),
    treatment_id: DataTypes.INTEGER,
    name: { type: DataTypes.STRING(180), allowNull: false },
    unit_label: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'sesiones' },
    total_units: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    available_units: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    sold_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    activation_rule: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'on_first_payment' },
    status: { type: DataTypes.STRING(20), allowNull: false },
    expires_at: DataTypes.DATE,
    source_system: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'clinicaclick' },
    source_reference: DataTypes.STRING(120),
    created_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'PatientVoucher',
    tableName: 'PatientVouchers',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return PatientVoucher;
};
