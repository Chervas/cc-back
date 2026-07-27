'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingFirm extends Model {}
  AccountingFirm.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    scope_key: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    scope_type: { type: DataTypes.STRING(20), allowNull: false },
    group_id: DataTypes.INTEGER,
    primary_clinic_id: DataTypes.INTEGER,
    name: { type: DataTypes.STRING(180), allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, {
    sequelize,
    modelName: 'AccountingFirm',
    tableName: 'AccountingFirms',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return AccountingFirm;
};
