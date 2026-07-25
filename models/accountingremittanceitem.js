'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingRemittanceItem extends Model {}
  AccountingRemittanceItem.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    remittance_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    mandate_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    budget_id: DataTypes.BIGINT.UNSIGNED,
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    concept: { type: DataTypes.STRING(140), allowNull: false },
    end_to_end_id: { type: DataTypes.STRING(35), allowNull: false },
  }, {
    sequelize,
    modelName: 'AccountingRemittanceItem',
    tableName: 'AccountingRemittanceItems',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: false,
  });
  return AccountingRemittanceItem;
};
