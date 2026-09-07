'use strict';
module.exports = (sequelize, DataTypes) => sequelize.define('TreatmentProgramRevision', {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  program_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  version_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  snapshot: { type: DataTypes.JSON, allowNull: false },
  actor_id: { type: DataTypes.INTEGER, allowNull: true },
  created_at: { type: DataTypes.DATE, allowNull: false },
}, { tableName: 'TreatmentProgramRevisions', underscored: true, timestamps: false, indexes: [{ unique: true, fields: ['program_id', 'version_number'] }] });
