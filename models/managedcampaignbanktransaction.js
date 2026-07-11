'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ManagedCampaignBankTransaction extends Model {}

  ManagedCampaignBankTransaction.init({
    id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
    bank_provider: { type: DataTypes.STRING(64), allowNull: false },
    bank_account_ref: DataTypes.STRING(191),
    booked_at: { type: DataTypes.DATE, allowNull: false },
    value_date: DataTypes.DATEONLY,
    amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EUR' },
    description: DataTypes.STRING(1024),
    bank_reference: { type: DataTypes.STRING(191), allowNull: false },
    status: { type: DataTypes.ENUM('unmatched', 'partially_matched', 'matched', 'ignored'), allowNull: false, defaultValue: 'unmatched' },
    metadata: DataTypes.JSON,
    created_by_user_id: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'ManagedCampaignBankTransaction',
    tableName: 'ManagedCampaignBankTransactions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
  });

  return ManagedCampaignBankTransaction;
};
