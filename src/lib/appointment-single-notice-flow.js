'use strict';

const POLICY = 'appointment_single_notice_v1';
const FAMILIES = [
  ['appointment_created', 'env_o_de_datos_de_la_cita_tras_agendar'],
  ['appointment_rescheduled', 'envio_de_datos_de_la_cita_tras_agendar_copy'],
  ['appointment_reminder_window', 'recordatorio_y_confirmacion_bed4b6'],
];
const keyOf = template => String(template?.template_key || '').replace(/__?clinic_\d+.*$/, '');
const scoped = template => FAMILIES.some(([trigger, key]) => template?.trigger_type === trigger && keyOf(template) === key);
const duration = config => {
  const multiplier = { minutes: 1, hours: 60, days: 1440 }[config?.timeout_unit];
  const value = Number(config?.timeout_duration);
  if (!multiplier || !Number.isFinite(value) || value <= 0) throw Error('single_notice_wait_invalid');
  return value * multiplier;
};
const followup = node => node?.type === 'action/send_whatsapp'
  && /^(clinicaclick_confirmacion_datos_cita_(hoy|24|48)|clinicaclick_recordatorio_dia_antes)_sin_respuesta(?:_v\d+)?$/
    .test(node.config?.template_name || node.config?.fallback_template_name || '');

function policyFor(template) {
  const retired = {};
  for (const node of template?.nodes || []) {
    const leg = node.type === 'delay/wait_response' && node.config?.[POLICY];
    if (leg?.revision === 1 && typeof leg.retired_node_id === 'string'
      && !(template.nodes || []).some(candidate => candidate.id === leg.retired_node_id)
      && (template.nodes || []).some(candidate => candidate.id === leg.first_send_node_id && candidate.type === 'action/send_whatsapp')) {
      const { revision, retired_node_id, ...details } = leg;
      retired[retired_node_id] = { ...details, wait_node_id: node.id };
    }
  }
  return Object.keys(retired).length ? { revision: 1, retired_nodes: retired } : null;
}

// Only removes a known silence-delivery leg. AI nodes, decisions, first sends,
// response edges and clinic customizations are otherwise copied unchanged.
function buildSingleNoticeFlow(template) {
  if (!scoped(template)) throw Error('single_notice_family_out_of_scope');
  const nodes = structuredClone(template.nodes);
  if (!Array.isArray(nodes)) throw Error('single_notice_nodes_invalid');
  const byId = new Map(nodes.map(node => [node.id, node]));
  const retired = {};
  for (const send of nodes.filter(followup)) {
    const incoming = nodes.filter(node => Object.values(node.outputs || {}).includes(send.id));
    const first = incoming[0];
    const last = byId.get(send.outputs?.on_success);
    if (incoming.length !== 1 || first.type !== 'delay/wait_response' || first.outputs.on_timeout !== send.id
      || last?.type !== 'delay/wait_response' || last.config?.listens_to_node_id !== send.id
      || last.outputs.on_timeout || send.outputs.on_fail) throw Error(`single_notice_incompatible:${send.id}`);
    let original = byId.get(first.config?.listens_to_node_id);
    // Older booking graphs listen through their change-status node.
    if (original?.type === 'action/change_status') {
      const sends = nodes.filter(node => node.type === 'action/send_whatsapp' && node.outputs?.on_success === original.id);
      if (sends.length === 1) original = sends[0];
    }
    if (original?.type !== 'action/send_whatsapp' || followup(original)) throw Error(`single_notice_anchor_invalid:${send.id}`);
    first.config.listens_to_node_id = original.id;
    retired[send.id] = { wait_node_id: last.id, first_send_node_id: original.id,
      original_wait_minutes: duration(last.config), total_wait_minutes: duration(first.config) + duration(last.config) };
    first.outputs.on_timeout = last.id;
    last.config.listens_to_node_id = original.id;
    last.config.timeout_duration = retired[send.id].total_wait_minutes;
    last.config.timeout_unit = 'minutes';
    last.config[POLICY] = { revision: 1, retired_node_id: send.id, ...retired[send.id] };
  }
  const previous = policyFor(template);
  if (!Object.keys(retired).length && !previous?.retired_nodes) throw Error('single_notice_no_known_followup');
  const referencesRetired = value => Array.isArray(value) ? value.some(referencesRetired)
    : value && typeof value === 'object' ? Object.entries(value).some(([key,item]) => key !== POLICY && referencesRetired(item))
      : typeof value === 'string' && Object.keys(retired).some(id => value === id || value.includes(`outputs.${id}.`) || value.includes(`outputs.${id}}`));
  if (nodes.some(node => !retired[node.id] && referencesRetired(node.config))) throw Error('single_notice_reference_requires_review');
  return { entry_node_id: template.entry_node_id, trigger_type: template.trigger_type,
    trigger_config: { ...structuredClone(template.trigger_config || {}), [POLICY]: previous || { revision: 1, retired_nodes: retired } },
    nodes: nodes.filter(node => !retired[node.id]) };
}

function runtimeSingleNoticeFlow(template, latest, context = {}) {
  if (!scoped(template) || !policyFor(latest)) return { nodes: template.nodes, redirected: {} };
  const result = buildSingleNoticeFlow(template);
  const retired = result.trigger_config[POLICY].retired_nodes;
  for (const [sendId, leg] of Object.entries(retired)) {
    const output = context.outputs?.[sendId];
    // A follow-up already accepted before cutover keeps its real correlation
    // anchor and expiry. Never reinterpret that response as one to another send.
    if (output?.message_id && !output.suppressed && (['sent', 'delivered', 'read'].includes(output.status)
      || output.provider_acceptance_at || output.wamid || output.provider_accepted === true
      || output.delivery_unknown || output.outcome_unknown)) {
      const originalWait = template.nodes.find(node => node.id === leg.wait_node_id);
      const index = result.nodes.findIndex(node => node.id === leg.wait_node_id);
      if (originalWait && index >= 0) result.nodes[index] = structuredClone(originalWait);
    }
  }
  return { nodes: result.nodes, redirected: retired };
}

function waitingCutoverPatch(execution, runtime) {
  const retired = runtime.redirected[execution.current_node_id];
  const leg = retired || Object.values(runtime.redirected).find(value => value.wait_node_id === execution.current_node_id);
  if (!leg) return null;
  const wait = runtime.nodes.find(node => node.id === leg.wait_node_id);
  if (wait?.config?.listens_to_node_id !== leg.first_send_node_id) return retired
    ? { current_node_id: wait.id, status: 'running', waiting_meta: null, wait_until: null } : null;
  const first = execution.context?.outputs?.[leg.first_send_node_id];
  const anchor = new Date(first?.effective_send_at || first?.at || 'invalid');
  if (!Number.isFinite(anchor.getTime())) {
    throw Object.assign(Error('single_notice_anchor_requires_review'), { preserveFlowState: true });
  }
  return { current_node_id: wait.id,
    waiting_meta: { ...(execution.waiting_meta?.type === 'delay/wait_response' ? execution.waiting_meta : {}),
      type: 'delay/wait_response', listens_to_node_id: leg.first_send_node_id,
      wait_starts_at: anchor.toISOString(), on_response: wait.outputs?.on_response || null,
      on_timeout: wait.outputs?.on_timeout || null, response_buffer_enabled: wait.config.response_buffer_enabled !== false },
    wait_until: new Date(anchor.getTime() + leg.total_wait_minutes * 60000),
    status: execution.status === 'waiting' ? 'waiting' : 'running' };
}

function isRetiredDelivery(template, nodeId) {
  return scoped(template) && !!policyFor(template)?.retired_nodes?.[nodeId];
}

module.exports = { POLICY, scoped, policyFor, buildSingleNoticeFlow, runtimeSingleNoticeFlow, waitingCutoverPatch, isRetiredDelivery };
