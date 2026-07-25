'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingIngestionJob extends Model {}
  AccountingIngestionJob.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    source_asset_id: { type: DataTypes.INTEGER, allowNull: false },
    expense_document_id: DataTypes.BIGINT.UNSIGNED,
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' },
    provider: DataTypes.STRING(40),
    model: DataTypes.STRING(100),
    extracted_data: DataTypes.JSON,
    confidence: DataTypes.DECIMAL(5, 4),
    error_code: DataTypes.STRING(80),
    error_message: DataTypes.STRING(1000),
    attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    created_by: DataTypes.INTEGER,
    reviewed_by: DataTypes.INTEGER,
    processed_at: DataTypes.DATE,
    reviewed_at: DataTypes.DATE,
  }, {
    sequelize,
    modelName: 'AccountingIngestionJob',
    tableName: 'AccountingIngestionJobs',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return AccountingIngestionJob;
};
