'use strict';

function parseJson(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function buildNodes(currentNodes) {
  const nodes = Array.isArray(currentNodes) ? currentNodes.map((node) => ({ ...node })) : [];
  if (nodes.some((node) => node.id === 'N13' && node.type === 'condition/ai_analysis')) return nodes;
  const thresholdNode = nodes.find((node) => node.id === 'N5');
  if (!thresholdNode) return nodes;
  const threshold = Number(thresholdNode.config?.right_value || 5) || 5;
  thresholdNode.config = {
    mode: 'simple',
    left_ref: {
      source: 'context',
      path: 'last_response_context.response_rating',
      value_type: 'number',
      label: 'Valoración del paciente',
    },
    operator: 'exists',
    right_value: null,
  };
  thresholdNode.outputs = { on_true: 'N8', on_false: 'N13' };
  const ratingThresholdNode = nodes.find((node) => node.id === 'N8');
  if (ratingThresholdNode) {
    ratingThresholdNode.config = {
      mode: 'simple',
      left_ref: { source: 'context', path: 'last_response_context.response_rating', value_type: 'number', label: 'Valoración del paciente' },
      operator: 'greater_than_or_equals',
      right_value: threshold,
    };
    ratingThresholdNode.outputs = { on_true: 'N6', on_false: 'N7' };
  } else {
    nodes.push({
      id: 'N8', type: 'condition/field_check', position: { x: 610, y: 500 },
      config: {
        mode: 'simple',
        left_ref: { source: 'context', path: 'last_response_context.response_rating', value_type: 'number', label: 'Valoración del paciente' },
        operator: 'greater_than_or_equals', right_value: threshold,
      },
      outputs: { on_true: 'N6', on_false: 'N7' },
    });
  }
  return nodes.concat([
    {
      id: 'N13', type: 'condition/ai_analysis', position: { x: 610, y: 800 },
      config: {
        preset_key: 'review_response_classifier',
        instruction: 'Clasifica la intención de la respuesta del paciente a la solicitud de reseña.',
        context_sources: [{ key: 'respuesta', path: '{{last_response_context.response_text}}' }],
        output_fields: [
          { name: 'response_intent', type: 'string', description: 'rating, marketing_opt_out, wrong_recipient, review_refusal o ambiguous' },
          { name: 'response_rating', type: 'number', description: 'Valoración de 1 a 5 o 0 si no existe' },
          { name: 'confidence', type: 'number', description: 'Confianza entre 0 y 1' },
          { name: 'reason', type: 'string', description: 'Motivo breve de la clasificación' },
        ],
        mode: 'quick_qa', max_tokens: 180,
      },
      outputs: { on_success: 'N14', on_fail: 'N14' },
    },
    {
      id: 'N14', type: 'action/process_review_response_classification', position: { x: 850, y: 800 },
      config: { source_node_id: 'N13' }, outputs: { on_success: 'N15' },
    },
    {
      id: 'N15', type: 'condition/field_check', position: { x: 1080, y: 800 },
      config: {
        mode: 'simple',
        left_ref: { source: 'context', path: 'outputs.N14.response_intent', value_type: 'string', label: 'Intención clasificada' },
        operator: 'equals', right_value: 'rating',
      },
      outputs: { on_true: 'N16', on_false: null },
    },
    {
      id: 'N16', type: 'condition/field_check', position: { x: 1280, y: 800 },
      config: {
        mode: 'simple',
        left_ref: { source: 'context', path: 'outputs.N14.response_rating', value_type: 'number', label: 'Valoración clasificada' },
        operator: 'greater_than_or_equals', right_value: threshold,
      },
      outputs: { on_true: 'N6', on_false: 'N7' },
    },
  ]);
}

function pickExistingColumns(payload, tableDefinition) {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => tableDefinition[key]));
}

module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      const tableDefinition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
      const rows = await queryInterface.sequelize.query(`
        SELECT id, public_id, template_key, version, engine_version, name, description,
               trigger_type, trigger_config, is_active, is_system, clinic_id, group_id,
               entry_node_id, nodes, published_at, published_by, created_by
        FROM AutomationFlowTemplatesV2
        WHERE trigger_type = 'appointment_completed'
        ORDER BY template_key ASC, version ASC
        FOR UPDATE
      `, { type: queryInterface.sequelize.QueryTypes.SELECT, transaction });
      const families = new Map();
      rows.forEach((row) => {
        const key = row.public_id || row.template_key;
        if (!families.has(key)) families.set(key, []);
        families.get(key).push(row);
      });
      const now = new Date();
      const published = [];
      for (const familyRows of families.values()) {
        const row = [...familyRows]
          .reverse()
          .find((candidate) => candidate.published_at);
        if (!row) continue;
        const triggerConfig = parseJson(row.trigger_config, {});
        if (triggerConfig.managed_feature !== 'review_request') continue;
        const currentNodes = parseJson(row.nodes, []);
        const nodes = buildNodes(currentNodes);
        if (currentNodes.some((node) => node.id === 'N13')) continue;
        const nextVersion = Math.max(...familyRows.map((candidate) => Number(candidate.version || 0))) + 1;
        for (const activeRow of familyRows.filter((candidate) => Number(candidate.is_active) === 1)) {
          await queryInterface.bulkUpdate(
            'AutomationFlowTemplatesV2',
            { is_active: false, updated_at: now },
            { id: activeRow.id },
            { transaction }
          );
        }
        const payload = pickExistingColumns({
          public_id: row.public_id,
          template_key: row.template_key,
          version: nextVersion,
          engine_version: row.engine_version || 'v2',
          name: row.name,
          description: row.description,
          trigger_type: row.trigger_type,
          trigger_config: JSON.stringify(triggerConfig),
          is_active: Number(row.is_active) === 1,
          is_system: !!row.is_system,
          clinic_id: row.clinic_id,
          group_id: row.group_id,
          entry_node_id: row.entry_node_id,
          nodes: JSON.stringify(nodes),
          published_at: now,
          published_by: row.published_by || row.created_by,
          created_by: row.created_by,
          created_at: now,
          updated_at: now,
        }, tableDefinition);
        await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [payload], { transaction });
        published.push({ public_id: row.public_id, version: nextVersion });
      }
      const catalogDefinition = await queryInterface.describeTable('AutomationFlowCatalog').catch(() => ({}));
      for (const version of published) {
        const patch = pickExistingColumns({
          template_version: version.version,
          last_propagated_at: now,
          last_propagated_template_version: version.version,
          updated_at: now,
        }, catalogDefinition);
        if (version.public_id && Object.keys(patch).length) {
          await queryInterface.bulkUpdate(
            'AutomationFlowCatalog',
            patch,
            { template_key: version.public_id },
            { transaction }
          );
        }
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down() {
    // Versiones publicadas: no se eliminan para preservar ejecuciones históricas.
  },
  __testing: { buildNodes },
};
