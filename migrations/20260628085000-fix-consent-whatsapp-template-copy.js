'use strict';

const TEMPLATE_NAME = 'clinicaclick_envio_consentimiento_firma';
const PREVIOUS_BODY = 'Hola {{1}}, tienes documentación pendiente para {{2}} en {{3}}. Puedes revisarla y firmarla aquí: {{4}}';
const NEXT_BODY = 'Hola {{1}}, tienes documentación pendiente para {{2}} en {{3}}. Puedes revisarla y firmarla aquí: {{4}}\n\nGracias.';

function normalizeComponents(raw, bodyText) {
  if (!raw) return raw;
  let components = raw;
  if (typeof raw === 'string') {
    try {
      components = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (!Array.isArray(components)) return raw;
  return components.map((component) => {
    if (String(component?.type || '').toUpperCase() === 'BODY') {
      return {
        ...component,
        text: bodyText,
      };
    }
    return component;
  });
}

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT id, components FROM WhatsappTemplateCatalog WHERE name = ? LIMIT 1',
      { replacements: [TEMPLATE_NAME] }
    );
    if (!rows.length) return;

    const row = rows[0];
    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      {
        body_text: NEXT_BODY,
        components: JSON.stringify(normalizeComponents(row.components, NEXT_BODY)),
        updated_at: new Date(),
      },
      { id: row.id }
    );

    await queryInterface.sequelize.query(
      `UPDATE WhatsappTemplates
       SET is_active = 0, updatedAt = NOW()
       WHERE catalog_template_id = ?
         AND (name = ? OR name LIKE ?)
         AND status IN ('PENDING_LOCAL', 'REJECTED')
         AND meta_template_id IS NULL`,
      { replacements: [row.id, TEMPLATE_NAME, `${TEMPLATE_NAME}_v%`] }
    );
  },

  async down(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(
      'SELECT id, components FROM WhatsappTemplateCatalog WHERE name = ? LIMIT 1',
      { replacements: [TEMPLATE_NAME] }
    );
    if (!rows.length) return;

    const row = rows[0];
    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      {
        body_text: PREVIOUS_BODY,
        components: JSON.stringify(normalizeComponents(row.components, PREVIOUS_BODY)),
        updated_at: new Date(),
      },
      { id: row.id }
    );
  },
};
