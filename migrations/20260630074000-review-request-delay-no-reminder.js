'use strict';

const AUTOMATION_NAME = 'Solicitar reseña tras cita completada';
const CATALOG_NAME = 'auto_solicitar_resena';
const TRIGGER_TYPE = 'appointment_completed';
const REQUEST_TEMPLATE_NAME = 'clinicaclick_solicitar_resena';

function buildReviewNodes(existingConfig = {}) {
  const requestConfig = existingConfig.request || {};
  const threshold = Number(requestConfig.review_threshold || 5) || 5;

  return [
    {
      id: 'N1',
      type: 'trigger/appointment_completed',
      config: { event_name: TRIGGER_TYPE },
      outputs: { on_success: 'N2' },
      position: { x: 120, y: 120 },
    },
    {
      id: 'N2',
      type: 'delay/fixed',
      config: { duration: 24, unit: 'hours' },
      outputs: { on_complete: 'N3' },
      position: { x: 120, y: 280 },
    },
    {
      id: 'N3',
      type: 'action/request_review',
      config: {
        review_source: requestConfig.review_source || 'first_completed_or_completed_treatment',
        review_threshold: threshold,
        whatsapp_template_id: Number(requestConfig.whatsapp_template_id || 0) || null,
        template_name: REQUEST_TEMPLATE_NAME,
        review_gift_enabled: requestConfig.review_gift_enabled === true,
        review_gift_description: requestConfig.review_gift_description || null,
        review_display_clinic_name: requestConfig.review_display_clinic_name || null,
        require_message_anchor_for_wait: true,
        wait_for_message_ms: 6000,
      },
      outputs: { on_success: 'N4', on_fail: null },
      position: { x: 120, y: 440 },
    },
    {
      id: 'N4',
      type: 'delay/wait_response',
      config: {
        timeout_duration: 20,
        timeout_unit: 'hours',
        listens_to_node_id: 'N3',
        response_buffer_enabled: true,
      },
      outputs: { on_response: 'N5', on_timeout: 'N8' },
      position: { x: 120, y: 600 },
    },
    {
      id: 'N5',
      type: 'condition/field_check',
      config: {
        mode: 'simple',
        left_ref: {
          source: 'context',
          path: 'last_response_context.response_rating',
          value_type: 'number',
          label: 'Valoración del paciente',
        },
        operator: 'greater_than_or_equals',
        right_value: threshold,
      },
      outputs: { on_true: 'N6', on_false: 'N7' },
      position: { x: 430, y: 600 },
    },
    {
      id: 'N6',
      type: 'action/review_followup',
      config: { followup_kind: 'google_review', review_threshold: threshold },
      outputs: { on_success: null },
      position: { x: 720, y: 500 },
    },
    {
      id: 'N7',
      type: 'action/review_followup',
      config: { followup_kind: 'private_feedback', review_threshold: threshold },
      outputs: { on_success: null },
      position: { x: 720, y: 700 },
    },
    {
      id: 'N8',
      type: 'action/review_no_response',
      config: {
        list_id: '{{outputs.N3.list_id}}',
        item_id: '{{outputs.N3.item_id}}',
        reason: 'sin_respuesta_a_solicitud',
      },
      outputs: { on_success: null },
      position: { x: 120, y: 760 },
    },
  ];
}

function buildCatalogSteps() {
  return [
    { id: 1, orden: 1, nombre: 'Cita completada', tipo: 'trigger', config: { type: 'appointment_completed' }, siguiente_paso_id: 2 },
    { id: 2, orden: 2, nombre: 'Esperar 24h', tipo: 'delay', config: { type: 'fixed', duration: 24, unit: 'hours' }, siguiente_paso_id: 3 },
    { id: 3, orden: 3, nombre: 'Pedir valoración 1-5', tipo: 'action', config: { type: 'request_review' }, siguiente_paso_id: 4 },
    { id: 4, orden: 4, nombre: 'Esperar respuesta', tipo: 'delay', config: { type: 'wait_response', hours: 20 }, siguiente_paso_id: 5 },
    { id: 5, orden: 5, nombre: 'Comprobar valoración 5/5', tipo: 'condition', config: { type: 'field_check', field: 'valoracion_paciente', operator: 'greater_than_or_equals', value: 5 }, siguiente_paso_id: 6 },
    { id: 6, orden: 6, nombre: 'Enviar enlace de Google', tipo: 'action', config: { type: 'review_followup', followup_kind: 'google_review' }, siguiente_paso_id: 8 },
    { id: 7, orden: 7, nombre: 'Pedir motivo privado', tipo: 'action', config: { type: 'review_followup', followup_kind: 'private_feedback' }, siguiente_paso_id: 8 },
    { id: 8, orden: 8, nombre: 'Finalizar si no responde', tipo: 'action', config: { type: 'review_no_response' } },
  ];
}

function parseNodes(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function pickRequestConfig(row) {
  const nodes = parseNodes(row.nodes);
  const request = nodes.find((node) => node?.type === 'action/request_review');
  return { request: request?.config || {} };
}

function pickExistingColumns(payload, tableDefinition) {
  return Object.entries(payload).reduce((acc, [key, value]) => {
    if (tableDefinition[key]) acc[key] = value;
    return acc;
  }, {});
}

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const automationDefinition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
    const rows = await queryInterface.sequelize.query(
      `SELECT id, nodes
         FROM AutomationFlowTemplatesV2
        WHERE trigger_type = :triggerType
          AND (
            template_key = 'system_review_request_after_appointment_completed'
            OR template_key LIKE 'review_request_after_completed__clinic_%'
            OR public_id = 'flw_review_request_system'
            OR name = :automationName
            OR CAST(nodes AS CHAR) LIKE '%action/request_review%'
          )`,
      {
        replacements: { triggerType: TRIGGER_TYPE, automationName: AUTOMATION_NAME },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    for (const row of rows) {
      const nodes = buildReviewNodes(pickRequestConfig(row));
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        pickExistingColumns({
          version: 2,
          engine_version: 'v2',
          description: 'Espera 24h tras completar una cita, pide una valoración privada 1-5 y deriva a Google solo si responde 5/5.',
          entry_node_id: 'N1',
          nodes: JSON.stringify(nodes),
          updated_at: now,
        }, automationDefinition),
        { id: row.id }
      );
    }

    const catalogDefinition = await queryInterface.describeTable('AutomationFlowCatalog');
    await queryInterface.bulkUpdate(
      'AutomationFlowCatalog',
      pickExistingColumns({
        template_version: 2,
        display_name: AUTOMATION_NAME,
        description: 'Espera 24h, pide una valoración privada y deriva a Google solo si el paciente responde 5/5.',
        trigger_type: TRIGGER_TYPE,
        steps: JSON.stringify(buildCatalogSteps()),
        is_active: true,
        updated_at: now,
      }, catalogDefinition),
      { name: CATALOG_NAME }
    );
  },

  async down() {
    // No se restaura el recordatorio: puede molestar al paciente y ya no forma parte del flujo.
  },
};
