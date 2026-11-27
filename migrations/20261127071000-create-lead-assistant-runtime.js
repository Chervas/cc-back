'use strict';

module.exports = {
  async up(q, D) {
    await q.createTable('LeadAssistantPublications', {
      clinic_id: { type: D.INTEGER, primaryKey: true, allowNull: false },
      version: { type: D.INTEGER.UNSIGNED, primaryKey: true, allowNull: false },
      fields: { type: D.JSON, allowNull: false },
      approved_by: { type: D.INTEGER, allowNull: false },
      approved_at: { type: D.DATE, allowNull: false },
    });
    await q.createTable('LeadAssistantSessions', {
      conversation_id: { type: D.INTEGER, primaryKey: true, allowNull: false },
      clinic_id: { type: D.INTEGER, allowNull: false },
      template_id: { type: D.INTEGER, allowNull: false },
      publication_version: { type: D.INTEGER.UNSIGNED, allowNull: false },
      origin_message_id: { type: D.INTEGER, allowNull: false },
      origin_input: { type: D.STRING(32), allowNull: false },
      state: { type: D.STRING(16), allowNull: false },
      updated_at: { type: D.DATE, allowNull: false },
    });
  },
  async down() {
    throw new Error('Conservar las aprobaciones y conversaciones al volver a una versión anterior del código.');
  },
};
