'use strict';

function normalizeLegacyContextAliasInString(value) {
  return String(value || '')
    .replace(/\{\{\s*context\.last_prompt\s*\}\}/g, '{{last_prompt}}')
    .replace(/\{\{\s*context\.last_response\s*\}\}/g, '{{last_response}}')
    .replace(/\{\{\s*context\.last_response_context\./g, '{{last_response_context.')
    .replace(/\{\{\s*context\.last_form_submission\./g, '{{last_form_submission.');
}

function normalizeValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, normalizeValue(nestedValue)])
    );
  }
  if (typeof value === 'string') {
    return normalizeLegacyContextAliasInString(value);
  }
  return value;
}

module.exports = {
  async up(queryInterface) {
    const rows = await queryInterface.sequelize.query(
      `
        SELECT id, nodes
        FROM AutomationFlowTemplatesV2
        WHERE CAST(nodes AS CHAR) LIKE '%context.last_prompt%'
           OR CAST(nodes AS CHAR) LIKE '%context.last_response%'
           OR CAST(nodes AS CHAR) LIKE '%context.last_response_context%'
           OR CAST(nodes AS CHAR) LIKE '%context.last_form_submission%'
      `,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );

    for (const row of rows) {
      const normalizedNodes = normalizeValue(row.nodes);
      await queryInterface.sequelize.query(
        'UPDATE AutomationFlowTemplatesV2 SET nodes = :nodes WHERE id = :id',
        {
          replacements: {
            id: row.id,
            nodes: JSON.stringify(normalizedNodes),
          },
        }
      );
    }
  },

  async down() {
    // No revertimos el contenido: la forma canónica nueva es la única soportada.
  },
};
