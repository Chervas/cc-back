'use strict';

module.exports = {
  async up(query, D) {
    await query.createTable('LeadAssistantDrafts', {
      clinic_id: { type: D.INTEGER, primaryKey: true, allowNull: false },
      version: { type: D.INTEGER.UNSIGNED, allowNull: false },
      fields: { type: D.JSON, allowNull: false },
      updated_by: { type: D.INTEGER, allowNull: false },
      updated_at: { type: D.DATE, allowNull: false },
    });
  },
  async down() {
    throw new Error('El rollback de código conserva los borradores de las clínicas.');
  },
};
