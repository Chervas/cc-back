'use strict';

const TEMPLATE_NAME = 'clinicaclick_solicitar_resena';

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
          CAST(components AS CHAR) LIKE '%BUTTONS%'
          OR CAST(components AS CHAR) LIKE '%Responde con una valoración%'
          OR CAST(components AS CHAR) LIKE '%Cómo valorarías%'
          OR CAST(components AS CHAR) LIKE '%Como valorarias%'
        )
      `,
      { replacements: { catalogId: template.id } }
    );
  },

  async down() {
    // No-op: legacy button-based review templates should not be automatically reactivated.
  },
};
