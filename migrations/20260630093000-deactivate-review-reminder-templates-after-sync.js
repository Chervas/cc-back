'use strict';

const REMINDER_TEMPLATE_NAME = 'clinicaclick_recordatorio_resena_sin_respuesta';

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplates wt
      LEFT JOIN WhatsappTemplateCatalog c ON c.id = wt.catalog_template_id
         SET wt.is_active = 0,
             wt.updatedAt = :now
       WHERE wt.name = :name
          OR wt.name LIKE :familyName
          OR c.name = :name
      `,
      {
        replacements: {
          name: REMINDER_TEMPLATE_NAME,
          familyName: `${REMINDER_TEMPLATE_NAME}_v%`,
          now,
        },
      }
    );
  },

  async down() {
    // No-op: review reminders are intentionally retired. Re-enable explicitly
    // from admin/catalog if product policy changes.
  },
};
