'use strict';

const TEMPLATE_NAME = 'clinicaclick_aviso_cita_sin_confirmar_noche';
const AUTOMATION_TEMPLATE_KEY = 'system_cancel_unconfirmed_appointment_night_before';

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

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_err) {
    return [];
  }
}

async function requireCurrentCatalogBodyInAutomation(queryInterface) {
  const automationDefinition = await queryInterface.describeTable('AutomationFlowTemplatesV2');
  if (!automationDefinition.nodes) return;

  const rows = await queryInterface.sequelize.query(
    'SELECT id, nodes FROM AutomationFlowTemplatesV2 WHERE template_key = :templateKey',
    {
      replacements: { templateKey: AUTOMATION_TEMPLATE_KEY },
      type: queryInterface.sequelize.QueryTypes.SELECT,
    }
  );

  for (const row of rows) {
    const nodes = parseJsonArray(row.nodes);
    let changed = false;
    const nextNodes = nodes.map((node) => {
      if (node?.type !== 'action/send_whatsapp') return node;
      const config = node.config && typeof node.config === 'object' ? node.config : {};
      if (config.template_name !== TEMPLATE_NAME && config.template_usage !== 'cita_sin_confirmar_noche') {
        return node;
      }
      changed = true;
      return {
        ...node,
        config: {
          ...config,
          require_current_catalog_body: true,
        },
      };
    });

    if (changed) {
      await queryInterface.bulkUpdate(
        'AutomationFlowTemplatesV2',
        {
          nodes: JSON.stringify(nextNodes),
          updated_at: new Date(),
        },
        { id: row.id }
      );
    }
  }
}

module.exports = {
  async up(queryInterface) {
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
      updated_at: new Date(),
    }, tableDefinition);

    await queryInterface.bulkUpdate('WhatsappTemplateCatalog', payload, { name: TEMPLATE_NAME });
    await requireCurrentCatalogBodyInAutomation(queryInterface);
  },

  async down(queryInterface) {
    const tableDefinition = await queryInterface.describeTable('WhatsappTemplateCatalog');
    const payload = pickExistingColumns({
      body_text: [
        'Hola {{1}}, tu cita de mañana a las {{2}} en {{3}} sigue sin confirmar.',
        '',
        'Para poder mantenerla necesitamos que nos confirmes en los próximos minutos.',
        '',
        'Puedes responder:',
        'Confirmo',
        'Necesito reprogramar',
        'Cancelar',
        '',
        'Si no recibimos respuesta, la cancelaremos para liberar el hueco.',
      ].join('\n'),
      updated_at: new Date(),
    }, tableDefinition);

    await queryInterface.bulkUpdate('WhatsappTemplateCatalog', payload, { name: TEMPLATE_NAME });
  },
};
