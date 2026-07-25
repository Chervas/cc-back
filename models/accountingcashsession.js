'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingCashSession extends Model {}

  AccountingCashSession.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    business_date: { type: DataTypes.DATEONLY, allowNull: false },
    opening_cash: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    suggested_opening_cash: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'open' },
    closure_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    opened_by: { type: DataTypes.INTEGER, allowNull: true },
    opened_at: { type: DataTypes.DATE, allowNull: false },
    closed_by: { type: DataTypes.INTEGER, allowNull: true },
    closed_at: { type: DataTypes.DATE, allowNull: true },
  }, {
    sequelize,
    modelName: 'AccountingCashSession',
    tableName: 'AccountingCashSessions',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return AccountingCashSession;
};
