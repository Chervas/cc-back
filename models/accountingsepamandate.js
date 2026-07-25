'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingSepaMandate extends Model {}
  AccountingSepaMandate.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    reference: { type: DataTypes.STRING(80), allowNull: false },
    account_holder: { type: DataTypes.STRING(180), allowNull: false },
    iban_envelope: { type: DataTypes.TEXT, allowNull: false },
    iban_last4: { type: DataTypes.STRING(4), allowNull: false },
    bic: DataTypes.STRING(11),
    signature_date: { type: DataTypes.DATEONLY, allowNull: false },
    scheme: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'CORE' },
    sequence_type: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'RCUR' },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    notes: DataTypes.TEXT,
    created_by: DataTypes.INTEGER,
    updated_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'AccountingSepaMandate',
    tableName: 'AccountingSepaMandates',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return AccountingSepaMandate;
};
