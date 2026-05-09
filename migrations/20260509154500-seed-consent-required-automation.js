'use strict';

const TEMPLATE_KEY = 'system_consentimientos_necesarios';
const PUBLIC_ID = 'flw_consent_required_system';
const CATALOG_NAME = 'auto_consentimientos_necesarios';

function buildNodes() {
  return [
    {
      id: 'start',
      type: 'trigger/consent_required',
      config: {},
      outputs: { on_success: 'send_email_stub' },
      position: { x: 100, y: 120 },
    },
    {
      id: 'send_email_stub',
      type: 'action/send_email',
      config: {
        subject: 'Consentimientos pendientes para tu cita',
        body_html: [
          '<p>Hola {{paciente.nombre}},</p>',
          '<p>Tenemos documentación pendiente para tu cita. Cuando el envío real por email esté conectado, este nodo incluirá el enlace seguro de firma.</p>',
          '<p>Clínica: {{clinica.nombre}}</p>',
        ].join('\n'),
        variables: {},
      },
      outputs: { on_success: 'notify_clinic', on_fail: 'notify_clinic' },
      position: { x: 100, y: 260 },
    },
    {
      id: 'notify_clinic',
      type: 'action/send_system_notification',
      config: {
        title: 'Consentimientos pendientes',
        message: 'La cita de {{paciente.nombre}} tiene consentimientos pendientes. Revisa la ficha o abre la firma en tablet desde la agenda.',
        assignee_type: 'role',
        assignee_id: 'admin',
      },
      outputs: { on_success: null, on_fail: null },
      position: { x: 100, y: 400 },
    },
  ];
}

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();
    const templateTable = await queryInterface.describeTable('AutomationFlowTemplatesV2');
    const catalogTable = await queryInterface.describeTable('AutomationFlowCatalog');
    const nodes = buildNodes();

    const existingTemplates = await queryInterface.sequelize.query(
      'SELECT id FROM AutomationFlowTemplatesV2 WHERE template_key = :templateKey LIMIT 1',
      {
        replacements: { templateKey: TEMPLATE_KEY },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    if (!existingTemplates.length) {
      const row = {
        template_key: TEMPLATE_KEY,
        version: 1,
        engine_version: 'v2',
        name: 'Consentimientos necesarios',
        description: 'Automatización base para avisar cuando una cita requiere consentimientos clínicos pendientes. El nodo de email queda en stub hasta conectar proveedor.',
        trigger_type: 'consent_required',
        is_active: true,
        is_system: true,
        clinic_id: null,
        group_id: null,
        entry_node_id: 'start',
        nodes: JSON.stringify(nodes),
        published_at: now,
        published_by: 1,
        created_by: 1,
        created_at: now,
        updated_at: now,
      };
      if (templateTable.public_id) row.public_id = PUBLIC_ID;
      if (templateTable.trigger_config) row.trigger_config = JSON.stringify({});
      await queryInterface.bulkInsert('AutomationFlowTemplatesV2', [row]);
    }

    const existingCatalog = await queryInterface.sequelize.query(
      'SELECT id FROM AutomationFlowCatalog WHERE name = :name LIMIT 1',
      {
        replacements: { name: CATALOG_NAME },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );

    if (!existingCatalog.length) {
      const catalogRow = {
        name: CATALOG_NAME,
        display_name: 'Consentimientos necesarios',
        description: 'Recomendada para enviar/registrar documentación pendiente cuando una cita requiere consentimientos.',
        trigger_type: 'consent_required',
        steps: JSON.stringify([
          { id: 1, orden: 1, nombre: 'Consentimiento necesario', tipo: 'trigger', config: { type: 'consent_required' }, siguiente_paso_id: 2 },
          { id: 2, orden: 2, nombre: 'Enviar Email (mock)', tipo: 'action', config: { type: 'enviar_email_mock' }, siguiente_paso_id: 3 },
          { id: 3, orden: 3, nombre: 'Notificar clínica', tipo: 'action', config: { type: 'notificacion_sistema' }, siguiente_paso_id: 4 },
          { id: 4, orden: 4, nombre: 'Fin', tipo: 'end', config: {} },
        ]),
        is_generic: true,
        is_active: true,
        created_at: now,
        updated_at: now,
      };
      if (catalogTable.template_key) catalogRow.template_key = PUBLIC_ID;
      if (catalogTable.template_version) catalogRow.template_version = 1;
      await queryInterface.bulkInsert('AutomationFlowCatalog', [catalogRow]);
    }
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('AutomationFlowCatalog', { name: CATALOG_NAME });
    await queryInterface.bulkDelete('AutomationFlowTemplatesV2', { template_key: TEMPLATE_KEY });
  },
};
