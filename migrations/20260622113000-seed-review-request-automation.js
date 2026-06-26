'use strict';

const TEMPLATE_NAME = 'clinicaclick_solicitar_resena';
const REMINDER_TEMPLATE_NAME = 'clinicaclick_recordatorio_resena_sin_respuesta';
const AUTOMATION_TEMPLATE_KEY = 'system_review_request_after_appointment_completed';
const AUTOMATION_PUBLIC_ID = 'flw_review_request_system';
const CATALOG_NAME = 'auto_solicitar_resena';

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

function buildAutomationNodes() {
  return [
    {
      id: 'N1',
      type: 'trigger/appointment_completed',
      config: { event_name: 'appointment_completed' },
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

async function upsertCatalogTemplate(queryInterface, name, payload) {
  const rows = await queryInterface.sequelize.query(
    'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
    {
      replacements: { name },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );

  if (rows.length) {
    await queryInterface.bulkUpdate('WhatsappTemplateCatalog', payload, { name });
  } else {
    await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{
      name,
      ...payload,
      created_at: payload.updated_at || new Date(),
    }]);
  }
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

    const templateTable = await queryInterface.describeTable('AutomationFlowTemplatesV2');
    const nodes = buildAutomationNodes();
    const existingAutomation = await queryInterface.sequelize.query(
      'SELECT id FROM AutomationFlowTemplatesV2 WHERE template_key = :templateKey LIMIT 1',
      {
        replacements: { templateKey: AUTOMATION_TEMPLATE_KEY },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    const automationPayload = {
      template_key: AUTOMATION_TEMPLATE_KEY,
      version: 2,
      engine_version: 'v2',
      name: 'Solicitar reseña tras cita completada',
      description: 'Plantilla base para pedir una valoración 1-5 al completar una cita. La clínica la activa desde campañas de reseñas.',
      trigger_type: 'appointment_completed',
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
    };
    if (templateTable.public_id) automationPayload.public_id = AUTOMATION_PUBLIC_ID;
    if (templateTable.trigger_config) automationPayload.trigger_config = JSON.stringify({ event_name: 'appointment_completed' });

    if (existingAutomation.length) {
      await queryInterface.bulkUpdate('AutomationFlowTemplatesV2', automationPayload, { template_key: AUTOMATION_TEMPLATE_KEY });
    } else {
      await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [{
        ...automationPayload,
        created_at: now,
      }]);
    }

    const catalogTable = await queryInterface.describeTable('AutomationFlowCatalog');
    const existingCatalog = await queryInterface.sequelize.query(
      'SELECT id FROM AutomationFlowCatalog WHERE name = :name LIMIT 1',
      {
        replacements: { name: CATALOG_NAME },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );
    const catalogPayload = {
      display_name: 'Solicitar reseña tras cita completada',
      description: 'Pide una valoración al paciente tras completar su primera cita o un tratamiento, y solo deriva a Google si supera el umbral configurado.',
      trigger_type: 'appointment_completed',
      steps: JSON.stringify([
        { id: 1, orden: 1, nombre: 'Cita completada', tipo: 'trigger', config: { type: 'appointment_completed' }, siguiente_paso_id: 2 },
        { id: 2, orden: 2, nombre: 'Pedir valoración 1-5', tipo: 'action', config: { type: 'request_review' }, siguiente_paso_id: 3 },
        { id: 3, orden: 3, nombre: 'Esperar respuesta', tipo: 'delay', config: { type: 'wait_response', hours: 20 }, siguiente_paso_id: 4 },
        { id: 4, orden: 4, nombre: 'Recordar si no responde', tipo: 'action', config: { type: 'request_review_reminder' }, siguiente_paso_id: 5 },
        { id: 5, orden: 5, nombre: 'Esperar respuesta final', tipo: 'delay', config: { type: 'wait_response', hours: 4 }, siguiente_paso_id: 6 },
        { id: 6, orden: 6, nombre: 'Derivar según puntuación', tipo: 'action', config: { type: 'review_followup' }, siguiente_paso_id: 7 },
        { id: 7, orden: 7, nombre: 'Finalizar si no responde', tipo: 'action', config: { type: 'review_no_response' }, siguiente_paso_id: 8 },
        { id: 8, orden: 8, nombre: 'Fin', tipo: 'end', config: {} },
      ]),
      is_generic: true,
      is_active: true,
      updated_at: now,
    };
    if (catalogTable.template_key) catalogPayload.template_key = AUTOMATION_PUBLIC_ID;
    if (catalogTable.template_version) catalogPayload.template_version = 2;
    if (catalogTable.is_default_for_trigger) catalogPayload.is_default_for_trigger = false;

    if (existingCatalog.length) {
      await queryInterface.bulkUpdate('AutomationFlowCatalog', catalogPayload, { name: CATALOG_NAME });
    } else {
      await queryInterface.bulkInsert('AutomationFlowCatalog', [{
        name: CATALOG_NAME,
        ...catalogPayload,
        created_at: now,
      }]);
    }
  },

  async down(queryInterface) {
    await queryInterface.bulkUpdate(
      'AutomationFlowTemplatesV2',
      { is_active: false, updated_at: new Date() },
      { template_key: AUTOMATION_TEMPLATE_KEY }
    );
    await queryInterface.bulkUpdate(
      'AutomationFlowCatalog',
      { is_active: false, updated_at: new Date() },
      { name: CATALOG_NAME }
    );
  },
};
