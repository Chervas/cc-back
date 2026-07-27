'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientVoucherMovement extends Model {}
  PatientVoucherMovement.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    voucher_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    movement_type: { type: DataTypes.STRING(20), allowNull: false },
    units: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    appointment_id: DataTypes.INTEGER,
    notes: DataTypes.TEXT,
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    created_by: DataTypes.INTEGER,
    created_at: DataTypes.DATE,
  }, {
    sequelize,
    modelName: 'PatientVoucherMovement',
    tableName: 'PatientVoucherMovements',
    timestamps: false,
  });
  return PatientVoucherMovement;
};
