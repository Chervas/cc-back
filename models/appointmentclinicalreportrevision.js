'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AppointmentClinicalReportRevision extends Model {}
  AppointmentClinicalReportRevision.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    report_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    version_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    status: { type: DataTypes.STRING(20), allowNull: false },
    snapshot: { type: DataTypes.JSON, allowNull: false },
    change_type: { type: DataTypes.STRING(20), allowNull: false },
    actor_id: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'AppointmentClinicalReportRevision',
    tableName: 'AppointmentClinicalReportRevisions',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: false,
  });
  return AppointmentClinicalReportRevision;
};
