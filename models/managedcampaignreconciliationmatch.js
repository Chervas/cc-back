'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ManagedCampaignReconciliationMatch extends Model {}

  ManagedCampaignReconciliationMatch.init({
    id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
    bank_transaction_id: { type: DataTypes.STRING(36), allowNull: false },
    funding_account_id: { type: DataTypes.STRING(36), allowNull: false },
    ledger_entry_id: DataTypes.STRING(36),
    amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    confidence: DataTypes.DECIMAL(5, 4),
    method: { type: DataTypes.ENUM('automatic', 'manual'), allowNull: false, defaultValue: 'manual' },
    status: { type: DataTypes.ENUM('proposed', 'confirmed', 'rejected'), allowNull: false, defaultValue: 'proposed' },
    notes: DataTypes.STRING(1024),
    created_by_user_id: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'ManagedCampaignReconciliationMatch',
    tableName: 'ManagedCampaignReconciliationMatches',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
  });

  return ManagedCampaignReconciliationMatch;
};
