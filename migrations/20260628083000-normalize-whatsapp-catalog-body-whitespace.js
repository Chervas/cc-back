'use strict';

const TEMPLATE_NAMES = [
  'clinicaclick_confirmacion_datos_cita_hoy',
  'clinicaclick_confirmacion_datos_cita_reprogramada_24',
];

function parseMaybeJson(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function normalizeComponents(value) {
  const parsed = parseMaybeJson(value) || [];
  if (!Array.isArray(parsed)) return parsed;
  return parsed.map((component) => {
    if (!component || typeof component !== 'object') return component;
    if (String(component.type || '').toUpperCase() !== 'BODY' || typeof component.text !== 'string') {
      return { ...component };
    }
    return {
      ...component,
      text: component.text.trim(),
    };
  });
}

async function updateCatalog(queryInterface, row) {
  const bodyText = typeof row.body_text === 'string' ? row.body_text.trim() : row.body_text;
  const components = normalizeComponents(row.components);
  await queryInterface.bulkUpdate(
    'WhatsappTemplateCatalog',
    {
      body_text: bodyText,
      components: JSON.stringify(components),
      propagation_state: null,
      updated_at: new Date(),
    },
    { id: row.id }
  );
}

module.exports = {
  async up(queryInterface) {
    const rows = await queryInterface.sequelize.query(
      `
      SELECT id, name, body_text, components
      FROM WhatsappTemplateCatalog
      WHERE name IN (:names)
      `,
      {
        replacements: { names: TEMPLATE_NAMES },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    for (const row of rows) {
      await updateCatalog(queryInterface, row);
    }
  },

  async down() {
    // No-op: removing trailing BODY whitespace is a canonicalization fix.
  },
};
