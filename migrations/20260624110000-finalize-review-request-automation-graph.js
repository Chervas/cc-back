'use strict';

const AUTOMATION_TEMPLATE_KEY = 'system_review_request_after_appointment_completed';
const AUTOMATION_PUBLIC_ID = 'flw_review_request_system';
const AUTOMATION_NAME = 'Solicitar reseña tras cita completada';
const CATALOG_NAME = 'auto_solicitar_resena';
const TRIGGER_TYPE = 'appointment_completed';
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
        review_source: 'first_completed_appointment',
        review_threshold: 5,
        whatsapp_template_id: null,
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
      outputs: { on_response: 'N6', on_timeout: 'N7' },
      position: { x: 120, y: 760 },
    },
    {
      id: 'N6',
      type: 'action/review_followup',
      config: {
        review_threshold: 5,
      },
      outputs: { on_success: null },
      position: { x: 430, y: 600 },
    },
    {
      id: 'N7',
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
    { id: 6, orden: 6, nombre: 'Derivar según puntuación', tipo: 'action', config: { type: 'review_followup' }, siguiente_paso_id: 7 },
    { id: 7, orden: 7, nombre: 'Finalizar si no responde', tipo: 'action', config: { type: 'review_no_response' }, siguiente_paso_id: 8 },
    { id: 8, orden: 8, nombre: 'Fin', tipo: 'end', config: {} },
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

async function upsertSystemTemplate(queryInterface, now, nodes) {
  const tableDefinition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
  const existing = await queryInterface.sequelize.query(
    `SELECT id
       FROM AutomationFlowTemplatesV2
      WHERE public_id = :publicId
         OR (template_key = :templateKey AND version = 2)
      LIMIT 1`,
    {
      replacements: { publicId: AUTOMATION_PUBLIC_ID, templateKey: AUTOMATION_TEMPLATE_KEY },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );

  const payload = pickExistingColumns({
    public_id: AUTOMATION_PUBLIC_ID,
    template_key: AUTOMATION_TEMPLATE_KEY,
    version: 2,
    engine_version: 'v2',
    name: AUTOMATION_NAME,
    description: 'Pide una valoración al completar una cita, espera respuesta, recuerda si no responde y cierra cada rama de forma trazable.',
    trigger_type: TRIGGER_TYPE,
    trigger_config: JSON.stringify({ event_name: TRIGGER_TYPE }),
    is_active: true,
    is_system: true,
    clinic_id: null,
    group_id: null,
    entry_node_id: 'N1',
    nodes: JSON.stringify(nodes),
    published_at: now,
    published_by: 1,
    created_by: 1,
    updated_at: now,
  }, tableDefinition);

  if (existing.length) {
    await queryInterface.bulkUpdate('AutomationFlowTemplatesV2', payload, { id: existing[0].id });
    return existing[0].id;
  }

  await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [{
    ...payload,
    ...(tableDefinition.created_at ? { created_at: now } : {}),
  }]);
  return null;
}

async function updateReviewAutomationRows(queryInterface, now, nodes) {
  const tableDefinition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
  const rows = await queryInterface.sequelize.query(
    `SELECT id, public_id, template_key, name, nodes
       FROM AutomationFlowTemplatesV2
      WHERE trigger_type = :triggerType`,
    {
      replacements: { triggerType: TRIGGER_TYPE },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );

  const payload = pickExistingColumns({
    engine_version: 'v2',
    entry_node_id: 'N1',
    nodes: JSON.stringify(nodes),
    version: 2,
    updated_at: now,
  }, tableDefinition);

  for (const row of rows.filter(rowContainsReviewAutomation)) {
    await queryInterface.bulkUpdate('AutomationFlowTemplatesV2', payload, { id: row.id });
  }
}

async function upsertCatalog(queryInterface, now) {
  const tableDefinition = await queryInterface.describeTable('AutomationFlowCatalog');
  const existing = await queryInterface.sequelize.query(
    'SELECT id FROM AutomationFlowCatalog WHERE name = :name LIMIT 1',
    {
      replacements: { name: CATALOG_NAME },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );

  const payload = pickExistingColumns({
    template_key: AUTOMATION_PUBLIC_ID,
    template_version: 2,
    display_name: AUTOMATION_NAME,
    description: 'Pide una valoración al paciente, espera respuesta, recuerda si no responde y solo deriva a Google si supera el umbral configurado.',
    trigger_type: TRIGGER_TYPE,
    steps: JSON.stringify(buildCatalogSteps()),
    is_generic: true,
    is_active: true,
    is_default_for_trigger: false,
    updated_at: now,
  }, tableDefinition);

  if (existing.length) {
    await queryInterface.bulkUpdate('AutomationFlowCatalog', payload, { id: existing[0].id });
    return;
  }

  await queryInterface.bulkInsert('AutomationFlowCatalog', [{
    name: CATALOG_NAME,
    ...payload,
    ...(tableDefinition.created_at ? { created_at: now } : {}),
  }]);
}

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const nodes = buildReviewNodes();

    await upsertSystemTemplate(queryInterface, now, nodes);
    await updateReviewAutomationRows(queryInterface, now, nodes);
    await upsertCatalog(queryInterface, now);
  },

  async down(queryInterface) {
    const now = new Date();
    await queryInterface.bulkUpdate(
      'AutomationFlowCatalog',
      { template_version: 1, updated_at: now },
      { name: CATALOG_NAME }
    ).catch(() => null);
  },
};
