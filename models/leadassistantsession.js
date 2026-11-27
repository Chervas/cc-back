'use strict';

module.exports = (sequelize, D) => sequelize.define('LeadAssistantSession', {
  conversation_id: { type: D.INTEGER, primaryKey: true, allowNull: false },
  clinic_id: { type: D.INTEGER, allowNull: false },
  template_id: { type: D.INTEGER, allowNull: false },
  publication_version: { type: D.INTEGER.UNSIGNED, allowNull: false },
  origin_message_id: { type: D.INTEGER, allowNull: false },
  origin_input: { type: D.STRING(32), allowNull: false },
  state: { type: D.STRING(16), allowNull: false },
  updated_at: { type: D.DATE, allowNull: false },
}, { tableName: 'LeadAssistantSessions', timestamps: false });
