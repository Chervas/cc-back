'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class EconomicBudgetSignatureRequest extends Model {}
  EconomicBudgetSignatureRequest.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    budget_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    budget_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    request_type: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'accept_full' },
    status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'pending' },
    channel: { type: DataTypes.STRING(30), allowNull: false },
    recipient: DataTypes.STRING(190),
    selected_payment_mode: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'patient_choice' },
    selected_financing_months: DataTypes.INTEGER.UNSIGNED,
    collection_method: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'pending' },
    signature_channel: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'mobile' },
    bank_data_policy: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'defer' },
    bank_data_status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'not_required' },
    accepted_amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    accepted_line_keys: DataTypes.JSON,
    snapshot_json: { type: DataTypes.JSON, allowNull: false },
    snapshot_hash: { type: DataTypes.STRING(64), allowNull: false },
    public_url: DataTypes.TEXT,
    delivery_result: DataTypes.JSON,
    signed_payload: DataTypes.JSON,
    expires_at: DataTypes.DATE,
    sent_at: DataTypes.DATE,
    viewed_at: DataTypes.DATE,
    signed_at: DataTypes.DATE,
    created_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'EconomicBudgetSignatureRequest',
    tableName: 'EconomicBudgetSignatureRequests',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return EconomicBudgetSignatureRequest;
};
