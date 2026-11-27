'use strict';

function attachSocialNodes(nodes, config) {
  if (!Object.keys(config.social_entries || {}).length) return nodes;
  const start = nodes.find((node) => node.id === 'N1');
  const assistant = Object.values(config.social_entries).some((rule) => rule.action === 'assistant');
  const ordinary = start.outputs.on_success;
  const whatsappRule = config.social_entries.whatsapp_dm;
  const whatsapp = ['message', 'assistant'].includes(whatsappRule?.action);
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
            outputs: { on_true: whatsappRule.action === 'assistant' ? 'social_assistant' : 'whatsapp_prepared', on_false: hasSocial ? 'social_route' : ordinary },
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
    ...(whatsappRule?.action === 'message' ? [{
      id: 'whatsapp_prepared', type: 'action/reply_with_prepared_whatsapp', config: {},
      outputs: { on_success: 'N10' }, position: { x: 960, y: 80 },
    }] : []),
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

function withAfterHoursReply(nodes, entryNodeId, config) {
  const trigger = nodes.find(node => node.id === entryNodeId && node.type === 'trigger/message_received');
  if (!trigger) return nodes;
  const routeId = 'after_hours_reply_route';
  const actionId = 'after_hours_cleo';
  const previous = nodes.find(node => node.id === routeId);
  const action = nodes.find(node => node.id === actionId);
  if (previous || action) {
    if (previous?.type !== 'condition/field_check' || previous.outputs?.on_true !== actionId
        || trigger.outputs?.on_success !== routeId || action?.type !== 'action/attend_with_lead_assistant')
      throw new Error('after_hours_route_conflict');
  }
  const original = previous ? previous.outputs.on_false : trigger.outputs?.on_success;
  const base = nodes.filter(node => node.id !== routeId && node.id !== actionId);
  if (config.after_hours_action !== 'assistant' && !previous) return nodes;
  const enabled = config.after_hours_action === 'assistant';
  const result = base.map(node => node.id !== entryNodeId ? node : {
    ...node, outputs: { ...node.outputs, on_success: enabled ? routeId : original },
  });
  if (!enabled) return result;
  return [...result, {
    id: routeId, type: 'condition/field_check', position: { x: 320, y: 300 },
    config: { mode: 'simple', left_ref: {source:'trigger_data',path:'event_kind',value_type:'string',label:'Canal'},
      operator: 'equals', right_value: 'whatsapp_dm' },
    outputs: { on_true: actionId, on_false: original },
  }, {
    id: actionId, type: 'action/attend_with_lead_assistant', config: {},
    outputs: { on_success: null }, position: { x: 640, y: 120 },
  }];
}
module.exports = { attachSocialNodes, withAfterHoursReply };
