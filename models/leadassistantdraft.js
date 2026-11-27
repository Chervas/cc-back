'use strict';

module.exports = (sequelize, D) => sequelize.define('LeadAssistantDraft', {
  clinic_id: { type: D.INTEGER, primaryKey: true, allowNull: false },
  version: { type: D.INTEGER.UNSIGNED, allowNull: false },
  fields: { type: D.JSON, allowNull: false },
  updated_by: { type: D.INTEGER, allowNull: false },
  updated_at: { type: D.DATE, allowNull: false },
}, { tableName: 'LeadAssistantDrafts', timestamps: false });
