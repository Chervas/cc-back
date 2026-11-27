'use strict';

function attachSocialNodes(nodes, config) {
  if (!Object.keys(config.social_entries || {}).length) return nodes;
  const start = nodes.find((node) => node.id === 'N1');
  const ordinary = start.outputs.on_success;
  start.outputs.on_success = 'social_route';
  return [
    ...nodes,
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
      outputs: { on_success: 'N10', on_review: 'social_notify', on_fail: 'social_notify' },
      position: { x: 960, y: 390 },
    },
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
  ];
}

module.exports = { attachSocialNodes };
