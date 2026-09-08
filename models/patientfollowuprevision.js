'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PatientFollowUpRevision extends Model {}
  PatientFollowUpRevision.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    follow_up_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    version_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    actor_id: DataTypes.INTEGER,
    change_type: { type: DataTypes.STRING(24), allowNull: false },
    snapshot: { type: DataTypes.JSON, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize, modelName: 'PatientFollowUpRevision', tableName: 'PatientFollowUpRevisions',
    timestamps: false, underscored: true,
  });
  return PatientFollowUpRevision;
};
