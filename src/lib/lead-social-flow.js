'use strict';

function attachSocialNodes(nodes, config) {
  if (!Object.keys(config.social_entries || {}).length) return nodes;
  const start = nodes.find((node) => node.id === 'N1');
  const assistant = Object.values(config.social_entries).some((rule) => rule.action === 'assistant');
  const ordinary = start.outputs.on_success;
  const whatsapp = config.social_entries.whatsapp_dm?.action === 'assistant';
  const hasSocial = Object.keys(config.social_entries).some((key) => key !== 'whatsapp_dm');
  start.outputs.on_success = whatsapp ? 'whatsapp_inbound_route' : 'social_route';
  return [
    ...nodes,
    ...(whatsapp
      ? [
          {
            id: 'whatsapp_inbound_route',
            type: 'condition/field_check',
            config: {
              mode: 'simple',
              left_ref: {
                source: 'trigger_data',
                path: 'event_kind',
                value_type: 'string',
                label: 'Origen de la entrada',
              },
              operator: 'equals',
              right_value: 'whatsapp_dm',
              true_label: 'Mensaje de WhatsApp',
              false_label: 'Otros orígenes',
            },
            outputs: { on_true: 'social_assistant', on_false: hasSocial ? 'social_route' : ordinary },
            position: { x: 640, y: 120 },
          },
        ]
      : []),
    ...(hasSocial
      ? [
          {
            id: 'social_route',
            type: 'condition/field_check',
            config: {
              mode: 'simple',
              left_ref: {
                source: 'trigger_data',
                path: 'event_kind',
                value_type: 'string',
                label: 'Origen de la entrada',
              },
              operator: 'equals',
              right_value: 'social',
              true_label: 'Redes',
              false_label: 'Otros orígenes',
            },
            outputs: { on_true: 'social_interest', on_false: config.sources?.length ? ordinary : 'N10' },
            position: { x: 640, y: 220 },
          },
          {
            id: 'social_interest',
            type: 'action/social_lead_interest',
            config: {},
            outputs: {
              on_success: 'N10',
              on_review: 'social_notify',
              on_fail: 'social_notify',
              ...(assistant ? { on_assistant: 'social_assistant' } : {}),
            },
            position: { x: 960, y: 390 },
          },
        ]
      : []),
    ...(assistant
      ? [
          {
            id: 'social_assistant',
            type: 'action/attend_with_lead_assistant',
            config: {},
            outputs: { on_success: 'N10' },
            position: { x: 1250, y: 390 },
          },
        ]
      : []),
    ...(hasSocial
      ? [
          {
            id: 'social_notify',
            type: 'action/send_system_notification',
            config: {
              title: 'Mensaje de redes pendiente de atención',
              message: 'Abre la conversación en QuickChat para revisar la consulta.',
              assignee_type: 'role',
              assignee_id: 'recepcion',
              display_mode: 'inbox',
            },
            outputs: { on_success: 'N10' },
            position: { x: 960, y: 570 },
          },
        ]
      : []),
  ];
}

module.exports = { attachSocialNodes };
