'use strict';

const AUTOMATION_TEMPLATE_KEY = 'system_review_request_after_appointment_completed';
const AUTOMATION_PUBLIC_ID = 'flw_review_request_system';
const AUTOMATION_NAME = 'Solicitar reseña tras cita completada';
const CATALOG_NAME = 'auto_solicitar_resena';
const TRIGGER_TYPE = 'appointment_completed';
const REQUEST_TEMPLATE_NAME = 'clinicaclick_solicitar_resena';
const REMINDER_TEMPLATE_NAME = 'clinicaclick_recordatorio_resena_sin_respuesta';

function buildReviewNodes() {
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
      type: 'action/request_review',
      config: {
        review_source: 'first_completed_or_completed_treatment',
        review_threshold: 5,
        whatsapp_template_id: null,
        template_name: REQUEST_TEMPLATE_NAME,
        require_message_anchor_for_wait: true,
        wait_for_message_ms: 6000,
      },
      outputs: { on_success: 'N3', on_fail: null },
      position: { x: 120, y: 280 },
    },
    {
      id: 'N3',
      type: 'delay/wait_response',
      config: {
        timeout_duration: 20,
        timeout_unit: 'hours',
        listens_to_node_id: 'N2',
        response_buffer_enabled: true,
      },
      outputs: { on_response: 'N6', on_timeout: 'N4' },
      position: { x: 120, y: 440 },
    },
    {
      id: 'N4',
      type: 'action/request_review_reminder',
      config: {
        list_id: '{{outputs.N2.list_id}}',
        item_id: '{{outputs.N2.item_id}}',
        clinic_id: '{{outputs.N2.clinic_id}}',
        trigger_message_id: '{{outputs.N2.message_id}}',
        template_name: REMINDER_TEMPLATE_NAME,
      },
      outputs: { on_success: 'N5', on_fail: null },
      position: { x: 120, y: 600 },
    },
    {
      id: 'N5',
      type: 'delay/wait_response',
      config: {
        timeout_duration: 4,
        timeout_unit: 'hours',
        listens_to_node_id: 'N4',
        response_buffer_enabled: true,
      },
      outputs: { on_response: 'N6', on_timeout: 'N9' },
      position: { x: 120, y: 760 },
    },
    {
      id: 'N6',
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
        right_value: 5,
      },
      outputs: { on_true: 'N7', on_false: 'N8' },
      position: { x: 430, y: 600 },
    },
    {
      id: 'N7',
      type: 'action/review_followup',
      config: {
        followup_kind: 'google_review',
        review_threshold: 5,
      },
      outputs: { on_success: null },
      position: { x: 720, y: 500 },
    },
    {
      id: 'N8',
      type: 'action/review_followup',
      config: {
        followup_kind: 'private_feedback',
        review_threshold: 5,
      },
      outputs: { on_success: null },
      position: { x: 720, y: 700 },
    },
    {
      id: 'N9',
      type: 'action/review_no_response',
      config: {
        list_id: '{{outputs.N2.list_id}}',
        item_id: '{{outputs.N2.item_id}}',
        reason: 'sin_respuesta_tras_recordatorio',
      },
      outputs: { on_success: null },
      position: { x: 120, y: 920 },
    },
  ];
}

function buildCatalogSteps() {
  return [
    { id: 1, orden: 1, nombre: 'Cita completada', tipo: 'trigger', config: { type: 'appointment_completed' }, siguiente_paso_id: 2 },
    { id: 2, orden: 2, nombre: 'Pedir valoración 1-5', tipo: 'action', config: { type: 'request_review' }, siguiente_paso_id: 3 },
    { id: 3, orden: 3, nombre: 'Esperar respuesta', tipo: 'delay', config: { type: 'wait_response', hours: 20 }, siguiente_paso_id: 4 },
    { id: 4, orden: 4, nombre: 'Recordar si no responde', tipo: 'action', config: { type: 'request_review_reminder' }, siguiente_paso_id: 5 },
    { id: 5, orden: 5, nombre: 'Esperar respuesta final', tipo: 'delay', config: { type: 'wait_response', hours: 4 }, siguiente_paso_id: 6 },
    { id: 6, orden: 6, nombre: 'Comprobar valoración 5/5', tipo: 'condition', config: { type: 'field_check', field: 'valoracion_paciente', operator: 'greater_than_or_equals', value: 5 }, siguiente_paso_id: 7 },
    { id: 7, orden: 7, nombre: 'Enviar enlace de Google', tipo: 'action', config: { type: 'review_followup', followup_kind: 'google_review' }, siguiente_paso_id: 9 },
    { id: 8, orden: 8, nombre: 'Pedir motivo privado', tipo: 'action', config: { type: 'review_followup', followup_kind: 'private_feedback' }, siguiente_paso_id: 9 },
    { id: 9, orden: 9, nombre: 'Finalizar si no responde', tipo: 'action', config: { type: 'review_no_response' }, siguiente_paso_id: 10 },
    { id: 10, orden: 10, nombre: 'Fin', tipo: 'end', config: {} },
  ];
}

function pickExistingColumns(payload, tableDefinition) {
  return Object.entries(payload).reduce((acc, [key, value]) => {
    if (tableDefinition[key]) acc[key] = value;
    return acc;
  }, {});
}

function rowContainsReviewAutomation(row) {
  const nodesText = typeof row.nodes === 'string' ? row.nodes : JSON.stringify(row.nodes || {});
  return row.template_key === AUTOMATION_TEMPLATE_KEY
    || row.public_id === AUTOMATION_PUBLIC_ID
    || row.name === AUTOMATION_NAME
    || nodesText.includes('action/request_review');
}

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const nodes = buildReviewNodes();
    const automationDefinition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
    const rows = await queryInterface.sequelize.query(
      `SELECT id, public_id, template_key, name, nodes
         FROM AutomationFlowTemplatesV2
        WHERE trigger_type = :triggerType`,
      {
        replacements: { triggerType: TRIGGER_TYPE },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    const templatePayload = pickExistingColumns({
      version: 2,
      engine_version: 'v2',
      description: 'Pide una valoración privada 1-5, recuerda si no responde y solo deriva a Google cuando el paciente valora 5/5.',
      entry_node_id: 'N1',
      nodes: JSON.stringify(nodes),
      updated_at: now,
    }, automationDefinition);

    for (const row of rows.filter(rowContainsReviewAutomation)) {
      await queryInterface.bulkUpdate('AutomationFlowTemplatesV2', templatePayload, { id: row.id });
    }

    const catalogDefinition = await queryInterface.describeTable('AutomationFlowCatalog');
    const catalogPayload = pickExistingColumns({
      template_key: AUTOMATION_PUBLIC_ID,
      template_version: 2,
      display_name: AUTOMATION_NAME,
      description: 'Pide una valoración privada y deriva a Google solo si el paciente responde 5/5.',
      trigger_type: TRIGGER_TYPE,
      steps: JSON.stringify(buildCatalogSteps()),
      is_generic: true,
      is_active: true,
      updated_at: now,
    }, catalogDefinition);

    await queryInterface.bulkUpdate('AutomationFlowCatalog', catalogPayload, { name: CATALOG_NAME });
  },

  async down() {
    // No revertimos automáticamente porque la versión anterior perdía la rama explícita de comprobación.
  },
};
