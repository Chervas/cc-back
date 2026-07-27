'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ClinicEconomicTemplate extends Model {}
  ClinicEconomicTemplate.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(36), allowNull: false, unique: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: false },
    template_type: { type: DataTypes.STRING(20), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    area_code: DataTypes.STRING(50),
    config: { type: DataTypes.JSON, allowNull: false },
    is_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_by: DataTypes.INTEGER,
    updated_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'ClinicEconomicTemplate',
    tableName: 'ClinicEconomicTemplates',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return ClinicEconomicTemplate;
};
