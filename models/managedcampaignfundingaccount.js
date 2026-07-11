'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ManagedCampaignFundingAccount extends Model {
    static associate(models) {
      if (models.ManagedCampaign) {
        ManagedCampaignFundingAccount.belongsTo(models.ManagedCampaign, {
          foreignKey: 'managed_campaign_id',
          as: 'campaign',
        });
      }
      if (models.ManagedCampaignLedgerEntry) {
        ManagedCampaignFundingAccount.hasMany(models.ManagedCampaignLedgerEntry, {
          foreignKey: 'funding_account_id',
          as: 'ledger_entries',
        });
      }
    }
  }

  ManagedCampaignFundingAccount.init({
    id: { type: DataTypes.STRING(36), primaryKey: true, allowNull: false },
    managed_campaign_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    grupo_clinica_id: DataTypes.INTEGER,
    currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'EUR' },
    status: { type: DataTypes.ENUM('unfunded', 'funded', 'low_balance', 'depleted', 'closed'), allowNull: false, defaultValue: 'unfunded' },
    client_gross_funded: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    commission_type: { type: DataTypes.ENUM('percentage', 'fixed'), allowNull: false, defaultValue: 'percentage' },
    commission_value: { type: DataTypes.DECIMAL(10, 4), allowNull: false, defaultValue: 0 },
    commission_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    media_budget_net: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    media_spend: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    reserved_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    available_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    terms_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  }, {
    sequelize,
    modelName: 'ManagedCampaignFundingAccount',
    tableName: 'ManagedCampaignFundingAccounts',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    underscored: true,
  });

  return ManagedCampaignFundingAccount;
};
