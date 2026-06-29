'use strict';

const TEMPLATE_NAME = 'clinicaclick_aviso_cita_sin_confirmar_noche';
const AUTOMATION_TEMPLATE_KEY = 'system_cancel_unconfirmed_appointment_night_before';
const AUTOMATION_PUBLIC_ID = 'flw_cancel_unconfirmed_appt_night_before';
const AUTOMATION_NAME = 'Cancelar cita sin confirmar la noche anterior';
const CATALOG_NAME = 'auto_cancelar_cita_sin_confirmar_noche';
const TRIGGER_TYPE = 'appointment_reminder_window';

const TEMPLATE_BODY = [
  'Hola {{1}}, te escribo porque no nos consta confirmada tu cita de mañana a las {{2}} en {{3}}.',
  '',
  'Para poder organizar la agenda, si no sabemos nada en los próximos minutos tendremos que liberar el hueco.',
  '',
  'Si quieres venir o necesitas cambiarla, respóndenos por aquí y lo vemos.',
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
    name: 'hora_cita',
    example: '10:30',
    description: 'Hora de la cita programada',
  },
  {
    position: 3,
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
      body_text: [['María', '10:30', 'Clínica Dental Centro']],
    },
  },
];

function pickExistingColumns(payload, tableDefinition) {
  return Object.entries(payload).reduce((acc, [key, value]) => {
    if (tableDefinition[key]) acc[key] = value;
    return acc;
  }, {});
}

async function upsertCatalogTemplate(queryInterface, now) {
  const tableDefinition = await queryInterface.describeTable('WhatsappTemplateCatalog');
  const payload = pickExistingColumns({
    display_name: 'Aviso nocturno de cita sin confirmar',
    category: 'UTILITY',
    body_text: TEMPLATE_BODY,
    variables: JSON.stringify(TEMPLATE_VARIABLES),
    components: JSON.stringify(TEMPLATE_COMPONENTS),
    propagation_state: null,
    is_generic: true,
    is_active: true,
    updated_at: now,
  }, tableDefinition);

  const rows = await queryInterface.sequelize.query(
    'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
    {
      replacements: { name: TEMPLATE_NAME },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );

  if (rows.length) {
    await queryInterface.bulkUpdate('WhatsappTemplateCatalog', payload, { name: TEMPLATE_NAME });
    return rows[0].id;
  }

  await queryInterface.bulkInsert('WhatsappTemplateCatalog', [{
    name: TEMPLATE_NAME,
    ...payload,
    created_at: now,
  }]);

  const created = await queryInterface.sequelize.query(
    'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name LIMIT 1',
    {
      replacements: { name: TEMPLATE_NAME },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );
  return created[0]?.id || null;
}

function buildAutomationNodes(catalogTemplateId) {
  const templateConfig = {
    message_mode: 'template',
    template_name: TEMPLATE_NAME,
    catalog_template_id: catalogTemplateId || null,
    require_current_catalog_body: true,
    language_code: 'es_ES',
    recipient_mode: 'context_patient',
    sender_mode: 'clinic_default',
    quiet_hours_enabled: false,
    variables_named: {
      nombre_paciente: '{{paciente.nombre}}',
      hora_cita: '{{cita.hora}}',
      nombre_clinica: '{{clinica.nombre}}',
    },
    template_usage: 'cita_sin_confirmar_noche',
  };

  return [
    {
      id: 'N1',
      type: 'trigger/appointment_reminder_window',
      config: {
        schedule_moment: 'day_before',
        schedule_time_mode: 'custom',
        custom_time: '21:00',
        only_if_not_confirmed: true,
      },
      outputs: { on_success: 'N2' },
      position: { x: 120, y: 120 },
    },
    {
      id: 'N2',
      type: 'action/send_whatsapp',
      config: templateConfig,
      outputs: { on_success: 'N3', on_fail: null },
      position: { x: 120, y: 280 },
    },
    {
      id: 'N3',
      type: 'delay/wait_response',
      config: {
        timeout_duration: 1,
        timeout_unit: 'hours',
        listens_to_node_id: 'N2',
        response_buffer_enabled: true,
      },
      outputs: { on_response: 'N4', on_timeout: 'N10' },
      position: { x: 120, y: 440 },
    },
    {
      id: 'N4',
      type: 'condition/ai_analysis',
      config: {
        preset_key: 'appointment_unconfirmed_reply',
        instruction: 'Clasifica la respuesta natural del paciente al aviso de cita sin confirmar como confirmar, reprogramar, cancelar o duda. No esperes palabras exactas: interpreta intención.',
        context_sources: [
          { key: 'respuesta', path: '{{last_response_context.response_text}}' },
          { key: 'cita', path: '{{cita.fecha}} {{cita.hora}}' },
        ],
        output_fields: [
          { name: 'decision', type: 'string', description: 'confirmar, reprogramar, cancelar o duda' },
          { name: 'motivo', type: 'string', description: 'Motivo breve de la clasificación' },
        ],
        mode: 'quick_qa',
        max_tokens: 180,
      },
      outputs: { on_success: 'N5', on_fail: 'N13' },
      position: { x: 420, y: 440 },
    },
    {
      id: 'N5',
      type: 'condition/field_check',
      config: {
        mode: 'simple',
        left_ref: {
          source: 'node_output',
          node_id: 'N4',
          path: 'decision',
          value_type: 'string',
          label: 'Respuesta del paciente',
        },
        operator: 'equals',
        right_value: 'confirmar',
      },
      outputs: { on_true: 'N6', on_false: 'N7' },
      position: { x: 700, y: 340 },
    },
    {
      id: 'N6',
      type: 'action/change_status',
      config: {
        target_entity: 'appointment',
        new_status: 'recordatorio_confirmado',
      },
      outputs: { on_success: 'N12', on_fail: null },
      position: { x: 980, y: 260 },
    },
    {
      id: 'N7',
      type: 'condition/field_check',
      config: {
        mode: 'simple',
        left_ref: {
          source: 'node_output',
          node_id: 'N4',
          path: 'decision',
          value_type: 'string',
          label: 'Respuesta del paciente',
        },
        operator: 'equals',
        right_value: 'reprogramar',
      },
      outputs: { on_true: 'N8', on_false: 'N11' },
      position: { x: 700, y: 560 },
    },
    {
      id: 'N8',
      type: 'action/change_status',
      config: {
        target_entity: 'appointment',
        new_status: 'cancelada',
      },
      outputs: { on_success: 'N9', on_fail: 'N9' },
      position: { x: 980, y: 500 },
    },
    {
      id: 'N9',
      type: 'action/send_system_notification',
      config: {
        title: 'Paciente pide reprogramar cita',
        message: '{{paciente.nombre}} ha pedido cambiar la cita de mañana a las {{cita.hora}}. Hemos liberado el hueco cancelando la cita. Contacta para darle una nueva hora y que vuelva a entrar en el proceso de confirmación.',
        assignee_type: 'role',
        assignee_id: 'personaldeclinica',
        subrole: 'Recepción / Comercial ventas',
      },
      outputs: { on_success: null, on_fail: null },
      position: { x: 1240, y: 500 },
    },
    {
      id: 'N11',
      type: 'condition/field_check',
      config: {
        mode: 'simple',
        left_ref: {
          source: 'node_output',
          node_id: 'N4',
          path: 'decision',
          value_type: 'string',
          label: 'Respuesta del paciente',
        },
        operator: 'equals',
        right_value: 'cancelar',
      },
      outputs: { on_true: 'N10', on_false: 'N13' },
      position: { x: 980, y: 660 },
    },
    {
      id: 'N10',
      type: 'action/change_status',
      config: {
        target_entity: 'appointment',
        new_status: 'cancelada',
      },
      outputs: { on_success: null, on_fail: null },
      position: { x: 980, y: 740 },
    },
    {
      id: 'N12',
      type: 'action/send_whatsapp',
      config: {
        message_mode: 'manual',
        manual_message_text: 'Gracias, queda confirmada. Te esperamos mañana a la hora prevista.',
        recipient_mode: 'context_patient',
        sender_mode: 'clinic_default',
        quiet_hours_enabled: false,
        template_usage: 'cita_sin_confirmar_confirmada',
      },
      outputs: { on_success: null, on_fail: null },
      position: { x: 1240, y: 260 },
    },
    {
      id: 'N13',
      type: 'action/send_system_notification',
      config: {
        title: 'Respuesta inconclusa a cita sin confirmar',
        message: '{{paciente.nombre}} ha respondido "{{last_response_context.response_text}}" al aviso de cita sin confirmar, pero no hemos podido saber si confirma, cancela o quiere cambiarla. Revisa la conversación antes de tocar la cita.',
        assignee_type: 'role',
        assignee_id: 'personaldeclinica',
        subrole: 'Recepción / Comercial ventas',
      },
      outputs: { on_success: null, on_fail: null },
      position: { x: 1240, y: 720 },
    },
  ];
}

function buildCatalogSteps() {
  return [
    { id: 1, orden: 1, nombre: 'Día antes 21:00', tipo: 'trigger', config: { type: 'appointment_reminder_window', schedule_moment: 'day_before', custom_time: '21:00', only_if_not_confirmed: true }, siguiente_paso_id: 2 },
    { id: 2, orden: 2, nombre: 'Avisar cita sin confirmar', tipo: 'action', config: { type: 'send_whatsapp', template_name: TEMPLATE_NAME }, siguiente_paso_id: 3 },
    { id: 3, orden: 3, nombre: 'Esperar 1 hora', tipo: 'delay', config: { type: 'wait_response', hours: 1 }, siguiente_paso_id: 4 },
    { id: 4, orden: 4, nombre: 'Clasificar respuesta', tipo: 'condition', config: { type: 'ai_analysis', preset_key: 'appointment_unconfirmed_reply' }, siguiente_paso_id: 5 },
    { id: 5, orden: 5, nombre: 'Si confirma, marcar confirmada', tipo: 'action', config: { type: 'change_status', new_status: 'recordatorio_confirmado' }, siguiente_paso_id: 9 },
    { id: 6, orden: 6, nombre: 'Si pide reprogramar, cancelar hueco y avisar a recepción', tipo: 'action', config: { type: 'change_status+send_system_notification', new_status: 'cancelada' }, siguiente_paso_id: 9 },
    { id: 7, orden: 7, nombre: 'Si cancela o no responde, cancelar cita', tipo: 'action', config: { type: 'change_status', new_status: 'cancelada' }, siguiente_paso_id: 9 },
    { id: 8, orden: 8, nombre: 'Si la respuesta no es clara, avisar a recepción', tipo: 'action', config: { type: 'send_system_notification' }, siguiente_paso_id: 9 },
    { id: 9, orden: 9, nombre: 'Fin', tipo: 'end', config: {} },
  ];
}

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const catalogTemplateId = await upsertCatalogTemplate(queryInterface, now);
    const nodes = buildAutomationNodes(catalogTemplateId);

    const automationDefinition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
    const automationPayload = pickExistingColumns({
      public_id: AUTOMATION_PUBLIC_ID,
      template_key: AUTOMATION_TEMPLATE_KEY,
      version: 1,
      engine_version: 'v2',
      name: AUTOMATION_NAME,
      description: 'Avisa a las 21:00 del día anterior si la cita sigue sin confirmar. La IA interpreta respuestas naturales: confirma la cita, libera el hueco y avisa a recepción si pide reprogramar, cancela si lo pide o no responde, y avisa a recepción si la respuesta no es clara.',
      trigger_type: TRIGGER_TYPE,
      trigger_config: JSON.stringify({
        schedule_moment: 'day_before',
        schedule_time_mode: 'custom',
        custom_time: '21:00',
        only_if_not_confirmed: true,
      }),
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
    }, automationDefinition);

    const existingAutomation = await queryInterface.sequelize.query(
      'SELECT id FROM AutomationFlowTemplatesV2 WHERE template_key = :templateKey AND version = 1 LIMIT 1',
      {
        replacements: { templateKey: AUTOMATION_TEMPLATE_KEY },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    if (existingAutomation.length) {
      await queryInterface.bulkUpdate('AutomationFlowTemplatesV2', automationPayload, { id: existingAutomation[0].id });
    } else {
      await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [{
        ...automationPayload,
        created_at: now,
      }]);
    }

    const catalogDefinition = await queryInterface.describeTable('AutomationFlowCatalog');
    const catalogPayload = pickExistingColumns({
      template_key: AUTOMATION_PUBLIC_ID,
      template_version: 1,
      display_name: AUTOMATION_NAME,
      description: 'Automatización operativa para liberar huecos de citas no confirmadas la noche anterior y derivar respuestas naturales a recepción cuando haga falta.',
      trigger_type: TRIGGER_TYPE,
      steps: JSON.stringify(buildCatalogSteps()),
      is_generic: true,
      is_active: true,
      is_default_for_trigger: false,
      updated_at: now,
    }, catalogDefinition);

    const existingCatalog = await queryInterface.sequelize.query(
      'SELECT id FROM AutomationFlowCatalog WHERE name = :name LIMIT 1',
      {
        replacements: { name: CATALOG_NAME },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    if (existingCatalog.length) {
      await queryInterface.bulkUpdate('AutomationFlowCatalog', catalogPayload, { id: existingCatalog[0].id });
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
