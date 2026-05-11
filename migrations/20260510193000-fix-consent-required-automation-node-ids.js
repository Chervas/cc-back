'use strict';

const TEMPLATE_KEY = 'system_consentimientos_necesarios';

function buildNodes() {
  return [
    {
      id: 'N1',
      type: 'trigger/consent_required',
      config: { min_hours_before: 24 },
      outputs: { on_success: 'N2' },
      position: { x: 100, y: 120 },
    },
    {
      id: 'N2',
      type: 'action/send_email',
      config: {
        subject: 'Consentimientos pendientes para tu cita',
        body_html: '<p>Hola {{paciente.nombre}}, revisa y firma tu documentación pendiente: {{consentimiento.enlace_publico}}</p><p>Este nodo queda preparado hasta conectar el proveedor real de email.</p>',
        variables: {},
      },
      outputs: { on_success: 'N3', on_fail: 'N3' },
      position: { x: 100, y: 260 },
    },
    {
      id: 'N3',
      type: 'action/send_whatsapp',
      config: {
        template_name: 'clinicaclick_envio_consentimiento_firma',
        public_link_variable: 'consentimiento.enlace_publico',
        mock_until_provider_ready: true,
        variables: {},
      },
      outputs: { on_success: 'N4', on_fail: 'N4' },
      position: { x: 100, y: 400 },
    },
    {
      id: 'N4',
      type: 'action/send_system_notification',
      config: {
        title: 'Consentimientos pendientes',
        message: 'La cita de {{paciente.nombre}} tiene consentimientos pendientes.',
        assignee_type: 'role',
        assignee_id: 'admin',
      },
      outputs: { on_success: null, on_fail: null },
      position: { x: 100, y: 540 },
    },
  ];
}

module.exports = {
  async up(queryInterface) {
    const now = new Date();
    await queryInterface.sequelize.query(
      `UPDATE AutomationFlowTemplatesV2
       SET entry_node_id = :entryNodeId,
           nodes = :nodes,
           trigger_config = :triggerConfig,
           updated_at = :updatedAt
       WHERE template_key = :templateKey`,
      {
        replacements: {
          templateKey: TEMPLATE_KEY,
          entryNodeId: 'N1',
          nodes: JSON.stringify(buildNodes()),
          triggerConfig: JSON.stringify({ min_hours_before: 24, supports_channels: ['email', 'whatsapp'] }),
          updatedAt: now,
        },
      }
    );
  },

  async down() {
    // No se revierte: la migración corrige IDs que el editor necesita para dibujar conexiones.
  },
};
