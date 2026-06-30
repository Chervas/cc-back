'use strict';

const REMINDER_TEMPLATE_NAME = 'clinicaclick_recordatorio_resena_sin_respuesta';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplates
      SET is_active = 0,
          updatedAt = NOW()
      WHERE name = :name
         OR name LIKE :versionedName
      `,
      {
        replacements: {
          name: REMINDER_TEMPLATE_NAME,
          versionedName: `${REMINDER_TEMPLATE_NAME}_v%`,
        },
      }
    );
  },

  async down() {
    // Intentionally left empty: retired review reminders should not be re-enabled automatically.
  },
};
