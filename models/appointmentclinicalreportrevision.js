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
    mutation_key: DataTypes.STRING(64),
    request_hash: DataTypes.STRING(64),
  }, {
    sequelize,
    modelName: 'AppointmentClinicalReportRevision',
    tableName: 'AppointmentClinicalReportRevisions',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [{ name: 'clinical_episode_revision_mutation_uq', unique: true, fields: ['report_id', 'mutation_key'] }],
  });
  return AppointmentClinicalReportRevision;
};
