'use strict';

const BASE_TEMPLATE_KEY = 'lead_auto_reply_system';
const BASE_PUBLIC_ID = 'flw_lead_auto_reply_system';
const CATALOG_NAME = 'auto_bienvenida_lead';
const FLOW_NAME = 'Contestar a los leads automáticamente';

function baseConfig() {
  return {
    managed_feature: 'lead_auto_reply',
    configured: false,
    sources: ['write', 'call'],
    timing: 'immediate',
    schedule_scope: 'clinic_hours',
    whatsapp_template_id: null,
    whatsapp_template_name: null,
    whatsapp_template_language: null,
  };
}

function buildNodes(catalogTemplateId) {
  const config = baseConfig();
  const schedule = {
    mode: 'clinic_schedule',
    timing: 'immediate',
    schedule_scope: 'clinic_hours',
    datetime_expression: '{{trigger.data.event_at}}',
  };
  return [
    { id: 'N1', type: 'trigger/lead_nuevo', config, outputs: { on_success: 'N2' }, position: { x: 120, y: 120 } },
    {
      id: 'N2', type: 'condition/field_check',
      config: {
        mode: 'simple',
        left_ref: { source: 'trigger_data', path: 'event_kind', value_type: 'string', label: 'Canal de entrada' },
        operator: 'equals', right_value: 'write',
      },
      outputs: { on_true: 'N3', on_false: 'N4' }, position: { x: 120, y: 280 },
    },
    { id: 'N3', type: 'delay/wait_until', config: schedule, outputs: { on_complete: 'N6' }, position: { x: 0, y: 440 } },
    { id: 'N4', type: 'delay/fixed', config: { duration: 1, unit: 'hours' }, outputs: { on_complete: 'N5' }, position: { x: 280, y: 440 } },
    { id: 'N5', type: 'delay/wait_until', config: schedule, outputs: { on_complete: 'N6' }, position: { x: 280, y: 600 } },
    {
      id: 'N6', type: 'condition/field_check',
      config: {
        mode: 'lead_contact_state',
        left_ref: { source: 'context', path: 'lead.id', value_type: 'number', label: 'Lead actual' },
        operator: 'exists',
      },
      outputs: { on_true: 'N7', on_false: 'N8' }, position: { x: 120, y: 760 },
    },
    {
      id: 'N7', type: 'action/send_whatsapp',
      config: {
        message_mode: 'template',
        catalog_template_id: catalogTemplateId || null,
        template_name: 'clinicaclick_lead_primera_visita_programar',
        language_code: 'es',
        recipient_mode: 'context_lead',
        sender_mode: 'clinic_default',
        quiet_hours_enabled: false,
        variables_named: {
          nombre_paciente: '{{lead.nombre}}',
          nombre_clinica: '{{clinica.nombre}}',
        },
        template_usage: 'lead_auto_reply',
      },
      outputs: { on_success: 'N8', on_fail: 'N8' }, position: { x: 120, y: 920 },
    },
    { id: 'N8', type: 'control/join', config: { mode: 'any' }, outputs: { on_joined: null }, position: { x: 120, y: 1080 } },
  ];
}

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const [catalogTemplate] = await queryInterface.sequelize.query(
      'SELECT id FROM WhatsappTemplateCatalog WHERE name = :name ORDER BY id ASC LIMIT 1',
      {
        replacements: { name: 'clinicaclick_lead_primera_visita_programar' },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );
    const rows = await queryInterface.sequelize.query(
      'SELECT id FROM AutomationFlowTemplatesV2 WHERE template_key = :templateKey AND version = 1 LIMIT 1',
      { replacements: { templateKey: BASE_TEMPLATE_KEY }, type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    const payload = {
      public_id: BASE_PUBLIC_ID,
      engine_version: 'v2',
      name: FLOW_NAME,
      description: 'Plantilla de sistema para responder nuevos leads por WhatsApp según canal, plazo y horario de clínica.',
      trigger_type: 'lead_nuevo',
      trigger_config: JSON.stringify(baseConfig()),
      is_active: false,
      is_system: true,
      clinic_id: null,
      group_id: null,
      entry_node_id: 'N1',
      nodes: JSON.stringify(buildNodes(catalogTemplate?.id || null)),
      published_at: now,
      published_by: 1,
      created_by: 1,
      updated_at: now,
    };
    if (rows.length) {
      await queryInterface.bulkUpdate('AutomationFlowTemplatesV2', payload, { id: rows[0].id });
    } else {
      await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [{
        template_key: BASE_TEMPLATE_KEY,
        version: 1,
        ...payload,
        created_at: now,
      }]);
    }

    await queryInterface.bulkUpdate('AutomationFlowCatalog', {
      display_name: FLOW_NAME,
      description: 'Contesta por WhatsApp a leads nuevos con reglas configurables por clínica.',
      trigger_type: 'lead_nuevo',
      template_key: BASE_TEMPLATE_KEY,
      template_version: 1,
      is_generic: true,
      is_active: true,
      is_default_for_trigger: false,
      updated_at: now,
    }, { name: CATALOG_NAME });
  },

  async down(queryInterface) {
    await queryInterface.bulkUpdate('AutomationFlowCatalog', {
      template_key: null,
      template_version: null,
      is_active: false,
      updated_at: new Date(),
    }, { name: CATALOG_NAME });
    await queryInterface.bulkDelete('AutomationFlowTemplatesV2', {
      template_key: BASE_TEMPLATE_KEY,
      clinic_id: null,
      is_system: true,
    });
  },
};
