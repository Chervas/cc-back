'use strict';

const CANONICAL_PRESETS = {
  confirm_appointment: {
    instruction: 'Analiza la conversación de hoy entre clínica y paciente. Clasifica en una de estas decisiones: confirmado, no_confirmado, dudas. Ten en cuenta quién escribe cada mensaje y la hora. Devuelve también confianza (0-1) y motivo breve.',
    context_sources: [
      { key: 'conversation_today', path: '{{conversation_today}}' },
      { key: 'responded_at', path: '{{last_response_context.responded_at}}' },
    ],
    output_fields: [
      { name: 'decision', type: 'string', description: 'confirmado, no_confirmado o dudas' },
      { name: 'confianza', type: 'number', description: 'Nivel de confianza de 0 a 1' },
      { name: 'motivo', type: 'string', description: 'Razón breve de la decisión' },
    ],
    legacy_instructions: [
      'Analiza la respuesta del paciente teniendo en cuenta el último mensaje enviado por la clínica. Clasifica en una de estas decisiones: confirmado, no_confirmado, dudas. Devuelve también confianza (0-1) y motivo breve.',
    ],
    legacy_source_sets: [
      ['{{last_prompt}}', '{{last_response}}'],
    ],
  },
  summarize_conversation: {
    instruction: 'Resume la conversación de hoy entre clínica y paciente en máximo 2 frases. Identifica el tema principal y si quedó alguna acción pendiente.',
    context_sources: [
      { key: 'conversation_today', path: '{{conversation_today}}' },
    ],
    output_fields: [
      { name: 'resumen', type: 'string', description: 'Resumen de la conversación en 2 frases' },
      { name: 'accion_pendiente', type: 'boolean', description: 'true si quedó algo pendiente' },
    ],
    legacy_instructions: [],
    legacy_source_sets: [
      ['{{last_prompt}}', '{{last_response}}'],
    ],
  },
};

function normalizeAlias(raw) {
  return String(raw || '')
    .replace(/\{\{\s*context\.last_prompt\s*\}\}/g, '{{last_prompt}}')
    .replace(/\{\{\s*context\.last_response\s*\}\}/g, '{{last_response}}')
    .replace(/\{\{\s*context\.last_response_context\./g, '{{last_response_context.')
    .replace(/\{\{\s*context\.conversation_today\s*\}\}/g, '{{conversation_today}}')
    .replace(/\{\{\s*context\.conversation_this_year\s*\}\}/g, '{{conversation_this_year}}')
    .replace(/\{\{\s*context\.conversation_all_time\s*\}\}/g, '{{conversation_all_time}}');
}

function normalizePath(source) {
  if (typeof source === 'string') return normalizeAlias(source);
  if (source && typeof source === 'object') return normalizeAlias(source.path || source.key || '');
  return '';
}

function matchesLegacy(config, canonical) {
  const instruction = String(config?.instruction || '').trim();
  if (instruction && canonical.legacy_instructions.includes(instruction)) return true;

  const currentPaths = Array.isArray(config?.context_sources)
    ? config.context_sources.map((source) => normalizePath(source)).filter(Boolean).sort()
    : [];

  return canonical.legacy_source_sets.some((legacySet) => {
    const normalizedLegacy = legacySet.map((item) => normalizeAlias(item)).sort();
    return JSON.stringify(currentPaths) === JSON.stringify(normalizedLegacy);
  });
}

function normalizeNode(node) {
  if (!node || typeof node !== 'object') return node;
  if (node.type !== 'condition/ai_analysis' || !node.config || typeof node.config !== 'object') return node;

  const presetKey = String(node.config.preset_key || '').trim();
  const canonical = CANONICAL_PRESETS[presetKey];
  if (!canonical || !matchesLegacy(node.config, canonical)) return node;

  return {
    ...node,
    config: {
      ...node.config,
      preset_key: presetKey,
      instruction: canonical.instruction,
      context_sources: canonical.context_sources.map((source) => ({ ...source })),
      output_fields: canonical.output_fields.map((field) => ({ ...field })),
    },
  };
}

module.exports = {
  async up(queryInterface) {
    const [rows] = await queryInterface.sequelize.query(`
      SELECT id, nodes
      FROM AutomationFlowTemplatesV2
      WHERE JSON_SEARCH(CAST(nodes AS CHAR), 'one', 'confirm_appointment') IS NOT NULL
         OR JSON_SEARCH(CAST(nodes AS CHAR), 'one', 'summarize_conversation') IS NOT NULL
    `);

    for (const row of rows) {
      const rawNodes = Array.isArray(row.nodes)
        ? row.nodes
        : (typeof row.nodes === 'string' ? JSON.parse(row.nodes || '[]') : []);
      const nextNodes = rawNodes.map((node) => normalizeNode(node));
      if (JSON.stringify(nextNodes) === JSON.stringify(rawNodes)) continue;

      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        { nodes: JSON.stringify(nextNodes) },
        { id: row.id }
      );
    }
  },

  async down() {
    // no-op: we do not restore legacy preset wiring
  },
};
