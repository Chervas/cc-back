'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class ClinicalDrawing extends Model {}
  ClinicalDrawing.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    patient_id: { type: DataTypes.INTEGER, allowNull: false },
    source_asset_id: { type: DataTypes.INTEGER, allowNull: true },
    template_key: { type: DataTypes.STRING(24), allowNull: false },
    template_version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    title: { type: DataTypes.STRING(180), allowNull: false },
    document: { type: DataTypes.JSON, allowNull: false },
    version_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'active' },
    idempotency_key: { type: DataTypes.STRING(80), allowNull: false },
    creation_hash: { type: DataTypes.STRING(64), allowNull: false },
    created_by: { type: DataTypes.INTEGER, allowNull: false },
    updated_by: { type: DataTypes.INTEGER, allowNull: false },
  }, { sequelize, modelName: 'ClinicalDrawing', tableName: 'ClinicalDrawings', underscored: true,
    createdAt: 'created_at', updatedAt: 'updated_at',
    indexes: [{ unique: true, fields: ['clinic_id', 'patient_id', 'idempotency_key'] }, { fields: ['clinic_id', 'patient_id', 'updated_at', 'id'] }],
  });
  return ClinicalDrawing;
};
