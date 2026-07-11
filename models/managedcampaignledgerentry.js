'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ManagedCampaignLedgerEntry extends Model {}

  ManagedCampaignLedgerEntry.init({
    id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
    funding_account_id: { type: DataTypes.STRING(36), allowNull: false },
    entry_type: { type: DataTypes.ENUM('topup', 'commission', 'media_reserve', 'media_spend', 'release', 'refund', 'adjustment', 'bank_charge'), allowNull: false },
    direction: { type: DataTypes.ENUM('credit', 'debit'), allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EUR' },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    external_ref: DataTypes.STRING(191),
    metadata: DataTypes.JSON,
    created_by_user_id: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'ManagedCampaignLedgerEntry',
    tableName: 'ManagedCampaignLedgerEntries',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
  });

  return ManagedCampaignLedgerEntry;
};
