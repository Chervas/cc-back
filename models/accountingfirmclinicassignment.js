'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccountingFirmClinicAssignment extends Model {}
  AccountingFirmClinicAssignment.init({
    firm_id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
    clinic_id: { type: DataTypes.INTEGER, primaryKey: true },
  }, {
    sequelize,
    modelName: 'AccountingFirmClinicAssignment',
    tableName: 'AccountingFirmClinicAssignments',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: false,
  });
  return AccountingFirmClinicAssignment;
};
