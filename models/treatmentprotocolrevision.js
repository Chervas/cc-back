'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, D) => {
  class TreatmentProtocolRevision extends Model {}
  TreatmentProtocolRevision.init({
    id: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, protocol_id: { type: D.INTEGER, allowNull: false },
    version: { type: D.INTEGER.UNSIGNED, allowNull: false }, snapshot: { type: D.JSON, allowNull: false }, actor_id: { type: D.INTEGER, allowNull: true },
  }, { sequelize, modelName: 'TreatmentProtocolRevision', tableName: 'TreatmentProtocolRevisions', timestamps: true, createdAt: 'created_at', updatedAt: false });
  return TreatmentProtocolRevision;
};
