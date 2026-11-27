'use strict';

module.exports = (sequelize, D) => sequelize.define('LeadAssistantPublication', {
  clinic_id: { type: D.INTEGER, primaryKey: true, allowNull: false },
  version: { type: D.INTEGER.UNSIGNED, primaryKey: true, allowNull: false },
  fields: { type: D.JSON, allowNull: false },
  approved_by: { type: D.INTEGER, allowNull: false },
  approved_at: { type: D.DATE, allowNull: false },
}, { tableName: 'LeadAssistantPublications', timestamps: false });
