'use strict';
module.exports = (sequelize, DataTypes) => {
  const TreatmentProgram = sequelize.define('TreatmentProgram', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(255), allowNull: false },
    kind: { type: DataTypes.STRING(16), allowNull: false },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'draft' },
    total_price: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    appointments: { type: DataTypes.JSON, allowNull: false },
    version_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    request_key: { type: DataTypes.STRING(64), allowNull: true, unique: true },
    request_payload_hash: { type: DataTypes.STRING(64), allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
    updated_by: { type: DataTypes.INTEGER, allowNull: true },
  }, { tableName: 'TreatmentPrograms', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
  return TreatmentProgram;
};
