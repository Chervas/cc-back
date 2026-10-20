'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class ClinicalDrawingRevision extends Model {}
  ClinicalDrawingRevision.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    drawing_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    version_number: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    snapshot: { type: DataTypes.JSON, allowNull: false },
    actor_id: { type: DataTypes.INTEGER, allowNull: false },
    change_type: { type: DataTypes.STRING(20), allowNull: false },
  }, { sequelize, modelName: 'ClinicalDrawingRevision', tableName: 'ClinicalDrawingRevisions', underscored: true,
    createdAt: 'created_at', updatedAt: false, indexes: [{ unique: true, fields: ['drawing_id', 'version_number'] }],
  });
  return ClinicalDrawingRevision;
};
