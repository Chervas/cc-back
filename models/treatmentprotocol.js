'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, D) => {
  class TreatmentProtocol extends Model {}
  TreatmentProtocol.init({
    id: { type: D.INTEGER, primaryKey: true, autoIncrement: true }, clinic_id: { type: D.INTEGER, allowNull: false },
    title: { type: D.STRING(200), allowNull: false }, kind: { type: D.STRING(20), allowNull: false }, status: { type: D.STRING(20), allowNull: false },
    version: { type: D.INTEGER.UNSIGNED, allowNull: false }, content: { type: D.TEXT('long'), allowNull: false }, source: D.STRING(500),
    treatment_ids: { type: D.JSON, allowNull: false }, created_by: D.INTEGER, updated_by: D.INTEGER, approved_by: D.INTEGER, approved_at: D.DATE,
  }, { sequelize, modelName: 'TreatmentProtocol', tableName: 'TreatmentProtocols', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at' });
  return TreatmentProtocol;
};
