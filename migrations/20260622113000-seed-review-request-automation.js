'use strict';

const TEMPLATE_NAME = 'clinicaclick_solicitar_resena';
const AUTOMATION_TEMPLATE_KEY = 'system_review_request_after_appointment_completed';
const AUTOMATION_PUBLIC_ID = 'flw_review_request_system';
const CATALOG_NAME = 'auto_solicitar_resena';

const TEMPLATE_BODY = [
  'Hola {{1}}, gracias por confiar en {{2}}.',
  '',
  'Nos importa mucho saber cómo te has sentido.',
  '',
  'Valora tu experiencia del 1 al 5:',
  '1 = Muy mala',
  '2 = Mala',
  '3 = Normal',
  '4 = Buena',
  '5 = Excelente',
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
  {
    type: 'BUTTONS',
    buttons: [
      { type: 'QUICK_REPLY', text: '1' },
      { type: 'QUICK_REPLY', text: '2' },
      { type: 'QUICK_REPLY', text: '3' },
      { type: 'QUICK_REPLY', text: '4' },
      { type: 'QUICK_REPLY', text: '5' },
    ],
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
      },
      outputs: { on_success: null, on_fail: null },
      position: { x: 120, y: 280 },
    },
  ];
}

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const templateRows = await queryInterface.sequelize.query(
      'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
      {
        replacements: { name: TEMPLATE_NAME },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    const templatePayload = {
      display_name: 'Solicitud de valoración 1-5',
      category: 'UTILITY',
      body_text: TEMPLATE_BODY,
      variables: JSON.stringify(TEMPLATE_VARIABLES),
      components: JSON.stringify(TEMPLATE_COMPONENTS),
      propagation_state: null,
      is_generic: true,
      is_active: true,
      updated_at: now,
    };

    if (templateRows.length) {
      await queryInterface.bulkUpdate('WhatsappTemplateCatalog', templatePayload, { name: TEMPLATE_NAME });
    } else {
      await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{
        name: TEMPLATE_NAME,
        ...templatePayload,
        created_at: now,
      }]);
    }

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
      version: 1,
      engine_version: 'v2',
      name: 'Solicitar reseña tras cita completada',
      description: 'Plantilla base para pedir una valoración 1-5 al completar una cita. La clínica la activa desde campañas de reseñas.',
      trigger_type: 'appointment_completed',
      is_active: false,
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
        { id: 3, orden: 3, nombre: 'Derivar según puntuación', tipo: 'action', config: { type: 'review_followup' }, siguiente_paso_id: 4 },
        { id: 4, orden: 4, nombre: 'Fin', tipo: 'end', config: {} },
      ]),
      is_generic: true,
      is_active: true,
      updated_at: now,
    };
    if (catalogTable.template_key) catalogPayload.template_key = AUTOMATION_PUBLIC_ID;
    if (catalogTable.template_version) catalogPayload.template_version = 1;
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
