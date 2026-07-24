'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingCashMovement extends Model {}

  AccountingCashMovement.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    movement_type: { type: DataTypes.STRING(30), allowNull: false },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    method: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'cash' },
    description: { type: DataTypes.STRING(255), allowNull: false },
    source_type: { type: DataTypes.STRING(60), allowNull: true },
    source_id: { type: DataTypes.STRING(80), allowNull: true },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'AccountingCashMovement',
    tableName: 'AccountingCashMovements',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: false,
  });

  return AccountingCashMovement;
};
