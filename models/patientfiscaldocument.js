'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientFiscalDocument extends Model {}
  PatientFiscalDocument.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    budget_id: DataTypes.BIGINT.UNSIGNED,
    payment_id: DataTypes.BIGINT.UNSIGNED,
    document_type: { type: DataTypes.STRING(20), allowNull: false },
    series: { type: DataTypes.STRING(30), allowNull: false },
    number: { type: DataTypes.STRING(60), allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'draft' },
    issue_date: { type: DataTypes.DATE, allowNull: false },
    due_date: DataTypes.DATE,
    issuer_snapshot: { type: DataTypes.JSON, allowNull: false },
    recipient_snapshot: { type: DataTypes.JSON, allowNull: false },
    lines: { type: DataTypes.JSON, allowNull: false },
    totals: { type: DataTypes.JSON, allowNull: false },
    payment_data: DataTypes.JSON,
    template_snapshot: { type: DataTypes.JSON, allowNull: false },
    verifactu_status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'mock_pending' },
    notes: DataTypes.TEXT,
    created_by: DataTypes.INTEGER,
    updated_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'PatientFiscalDocument',
    tableName: 'PatientFiscalDocuments',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return PatientFiscalDocument;
};
