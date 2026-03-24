'use strict';

function normalizeConversationContextAliasInString(value) {
  return String(value || '')
    .replace(/\{\{\s*context\.conversation_today\s*\}\}/g, '{{conversation_today}}')
    .replace(/\{\{\s*context\.conversation_this_year\s*\}\}/g, '{{conversation_this_year}}')
    .replace(/\{\{\s*context\.conversation_all_time\s*\}\}/g, '{{conversation_all_time}}');
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
    return normalizeConversationContextAliasInString(value);
  }
  return value;
}

module.exports = {
  async up(queryInterface) {
    const rows = await queryInterface.sequelize.query(
      `
        SELECT id, nodes
        FROM AutomationFlowTemplatesV2
        WHERE CAST(nodes AS CHAR) LIKE '%context.conversation_today%'
           OR CAST(nodes AS CHAR) LIKE '%context.conversation_this_year%'
           OR CAST(nodes AS CHAR) LIKE '%context.conversation_all_time%'
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
    // La forma canónica nueva es la única soportada.
  },
};
