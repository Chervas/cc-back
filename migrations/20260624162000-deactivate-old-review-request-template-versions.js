'use strict';

const TEMPLATE_NAME = 'clinicaclick_solicitar_resena';
const CURRENT_BODY_MARKER = 'Responde con el número de tu valoración';

module.exports = {
  async up(queryInterface) {
    const rows = await queryInterface.sequelize.query(
      'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
      {
        replacements: { name: TEMPLATE_NAME },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );
    const template = rows[0];
    if (!template) return;

    await queryInterface.sequelize.query(
      `
      UPDATE WhatsappTemplates
      SET is_active = 0,
          updatedAt = NOW()
      WHERE catalog_template_id = :catalogId
        AND is_active = 1
        AND (
          CAST(components AS CHAR) NOT LIKE :currentBodyMarker
          OR CAST(components AS CHAR) LIKE '%"BUTTONS"%'
          OR CAST(components AS CHAR) LIKE '%"buttons"%'
        )
      `,
      {
        replacements: {
          catalogId: template.id,
          currentBodyMarker: `%${CURRENT_BODY_MARKER}%`,
        },
      }
    );
  },

  async down() {
    // Intentionally no-op: old Meta templates should not be reactivated automatically.
  },
};
