'use strict';

const TEMPLATE_NAME = 'clinicaclick_solicitar_resena';
const REMINDER_TEMPLATE_NAME = 'clinicaclick_recordatorio_resena_sin_respuesta';
const AUTOMATION_TEMPLATE_KEY = 'system_review_request_after_appointment_completed';
const AUTOMATION_PUBLIC_ID = 'flw_review_request_system';
const AUTOMATION_NAME = 'Solicitar reseña tras cita completada';
const CATALOG_NAME = 'auto_solicitar_resena';
const TRIGGER_TYPE = 'appointment_completed';

const TEMPLATE_BODY = [
  '¡Hola {{1}}! ¿Te puedo hacer una pregunta si no es mucha molestia?',
  '',
  'Nos encantaría conocer tu opinión sobre cómo te atendimos en {{2}}.',
  '',
  'Responde con el número de tu valoración:',
  '',
  '1 ⭐',
  '2 ⭐⭐',
  '3 ⭐⭐⭐',
  '4 ⭐⭐⭐⭐',
  '5 ⭐⭐⭐⭐⭐',
  '',
  'Te llevará solo unos segundos.',
].join('\n');

const TEMPLATE_VARIABLES = [
  {
    position: 1,
    name: 'nombre_paciente',
    example: 'María',
    description: 'Nombre del paciente',
  },
  {
    position: 2,
    name: 'nombre_clinica',
    example: 'Clínica Dental Centro',
    description: 'Nombre de la clínica',
  },
];

const TEMPLATE_COMPONENTS = [
  {
    type: 'BODY',
    text: TEMPLATE_BODY,
    example: {
      body_text: [['María', 'Clínica Dental Centro']],
    },
  },
];

const REMINDER_TEMPLATE_BODY = [
  'Perdona la insistencia {{1}}, pero saber tu opinión nos ayuda mucho a mejorar.',
  '',
  '¿Podrías responder con el número de tu valoración?',
  '',
  '1 ⭐',
  '2 ⭐⭐',
  '3 ⭐⭐⭐',
  '4 ⭐⭐⭐⭐',
  '5 ⭐⭐⭐⭐⭐',
].join('\n');

const REMINDER_TEMPLATE_VARIABLES = [
  {
    position: 1,
    name: 'nombre_paciente',
    example: 'María',
    description: 'Nombre del paciente',
  },
];

const REMINDER_TEMPLATE_COMPONENTS = [
  {
    type: 'BODY',
    text: REMINDER_TEMPLATE_BODY,
    example: {
      body_text: [['María']],
    },
  },
];

function buildExtendedNodes() {
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

function buildLegacyNodes() {
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
      },
      outputs: { on_success: null, on_fail: null },
      position: { x: 120, y: 280 },
    },
  ];
}

function buildCatalogSteps({ extended }) {
  if (!extended) {
    return [
      { id: 1, orden: 1, nombre: 'Cita completada', tipo: 'trigger', config: { type: 'appointment_completed' }, siguiente_paso_id: 2 },
      { id: 2, orden: 2, nombre: 'Pedir valoración 1-5', tipo: 'action', config: { type: 'request_review' }, siguiente_paso_id: 3 },
      { id: 3, orden: 3, nombre: 'Derivar según puntuación', tipo: 'action', config: { type: 'review_followup' }, siguiente_paso_id: 4 },
      { id: 4, orden: 4, nombre: 'Fin', tipo: 'end', config: {} },
    ];
  }

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

async function upsertCatalogTemplate(queryInterface, name, payload) {
  const tableDefinition = await queryInterface.describeTable('WhatsappTemplateCatalog');
  const filteredPayload = pickExistingColumns(payload, tableDefinition);
  const rows = await queryInterface.sequelize.query(
    'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
    {
      replacements: { name },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );

  if (rows.length) {
    await queryInterface.bulkUpdate('WhatsappTemplateCatalog', filteredPayload, { name });
    return;
  }

  await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{
    name,
    ...filteredPayload,
    ...(tableDefinition.created_at ? { created_at: payload.updated_at || new Date() } : {}),
  }]);
}

function isReviewAutomationRow(row) {
  const nodesText = typeof row.nodes === 'string' ? row.nodes : JSON.stringify(row.nodes || '');
  return row.template_key === AUTOMATION_TEMPLATE_KEY
    || row.name === AUTOMATION_NAME
    || nodesText.includes('action/request_review');
}

async function updateAutomationRows(queryInterface, { extended, now }) {
  const tableDefinition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
  const rows = await queryInterface.sequelize.query(
    'SELECT id, template_key, name, trigger_type, nodes FROM AutomationFlowTemplatesV2 WHERE trigger_type = :triggerType',
    {
      replacements: { triggerType: TRIGGER_TYPE },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );
  const targets = rows.filter(isReviewAutomationRow);
  const nodes = extended ? buildExtendedNodes() : buildLegacyNodes();
  const payload = pickExistingColumns({
    engine_version: 'v2',
    entry_node_id: 'N1',
    nodes: JSON.stringify(nodes),
    version: extended ? 2 : 1,
    updated_at: now,
  }, tableDefinition);

  for (const row of targets) {
    await queryInterface.bulkUpdate('AutomationFlowTemplatesV2', payload, { id: row.id });
  }

  return targets.length;
}

async function upsertCatalog(queryInterface, { extended, now }) {
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
    template_version: extended ? 2 : 1,
    display_name: AUTOMATION_NAME,
    description: extended
      ? 'Pide una valoración al paciente, espera respuesta, recuerda si no responde y solo deriva a Google si supera el umbral configurado.'
      : 'Pide una valoración al paciente y solo deriva a Google si supera el umbral configurado.',
    trigger_type: TRIGGER_TYPE,
    steps: JSON.stringify(buildCatalogSteps({ extended })),
    is_generic: true,
    is_active: true,
    updated_at: now,
  }, tableDefinition);

  if (existing.length) {
    await queryInterface.bulkUpdate('AutomationFlowCatalog', payload, { name: CATALOG_NAME });
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

    await upsertCatalogTemplate(queryInterface, TEMPLATE_NAME, {
      display_name: 'Solicitud de valoración 1-5',
      category: 'UTILITY',
      body_text: TEMPLATE_BODY,
      variables: JSON.stringify(TEMPLATE_VARIABLES),
      components: JSON.stringify(TEMPLATE_COMPONENTS),
      propagation_state: null,
      is_generic: true,
      is_active: true,
      updated_at: now,
    });
    await upsertCatalogTemplate(queryInterface, REMINDER_TEMPLATE_NAME, {
      display_name: 'Recordatorio de valoración sin respuesta',
      category: 'UTILITY',
      body_text: REMINDER_TEMPLATE_BODY,
      variables: JSON.stringify(REMINDER_TEMPLATE_VARIABLES),
      components: JSON.stringify(REMINDER_TEMPLATE_COMPONENTS),
      propagation_state: null,
      is_generic: true,
      is_active: true,
      updated_at: now,
    });
    await updateAutomationRows(queryInterface, { extended: true, now });
    await upsertCatalog(queryInterface, { extended: true, now });
  },

  async down(queryInterface) {
    const now = new Date();
    await updateAutomationRows(queryInterface, { extended: false, now });
    await upsertCatalog(queryInterface, { extended: false, now });
    await queryInterface.bulkUpdate(
      'WhatsappTemplateCatalog',
      { is_active: false, updated_at: now },
      { name: REMINDER_TEMPLATE_NAME }
    ).catch(() => null);
  },
};
