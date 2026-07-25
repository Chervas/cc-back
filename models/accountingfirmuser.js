'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingFirmUser extends Model {}
  AccountingFirmUser.init({
    firm_id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, primaryKey: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
  }, {
    sequelize,
    modelName: 'AccountingFirmUser',
    tableName: 'AccountingFirmUsers',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return AccountingFirmUser;
};
