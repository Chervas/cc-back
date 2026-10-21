'use strict';

const C = require('./patient-program-booking-confirmation');
const single = require('./appointment-single-notice-flow');
const { formatDateLocal } = require('./availability-calendar');
const POLICY = 'program_booking_v1';
const PROTOCOL = 'native-appointment-program/v1';
const EVENTS = ['appointment_created', 'appointment_rescheduled'];
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const clone = value => JSON.parse(JSON.stringify(value));
const nativeFlow = execution => EVENTS.includes(execution?.trigger_type)
  && execution?.trigger_entity_type === 'appointment'
  && execution?.context?.program_confirmation?.protocol === PROTOCOL
  && !!C.id(execution.context.program_confirmation.request_event_id);
function operation(receipt) {
  const result = C.object(receipt?.result), rows = result.sessions;
  if (!Array.isArray(rows) || !rows.length || rows.some(row => !['created', 'rescheduled'].includes(row.action))) C.fail('program_details_receipt_invalid');
  const moved = rows.filter(row => row.action === 'rescheduled'
    && (C.time(row.previous_appointment?.start_at) !== C.time(row.start_at)
      || C.time(row.previous_appointment?.end_at) !== C.time(row.end_at)));
  const created = rows.filter(row => row.action === 'created');
  // A mixed operation belongs to reprogramming, never to two automations.
  const event = moved.length ? 'appointment_rescheduled' : 'appointment_created';
  const owner = [...(moved.length ? moved : created)].sort((a, b) => C.time(a.start_at) - C.time(b.start_at)
    || Number(a.appointment_id) - Number(b.appointment_id))[0];
  return { event, unchanged: !owner, ownerId: C.id(owner?.appointment_id), reason: result.reschedule_reason || (moved.length ? 'clinic_schedule' : null),
    declined: result.notice_decision?.send === false };
}
function normalProjection(template) {
  const policy = template.trigger_config?.[POLICY];
  if (!policy) return null;
  const nodes = clone(json(template.nodes)).filter(node => policy.normal_ids?.includes(node.id));
  const entry = nodes.find(node => node.id === template.entry_node_id);
  if (!entry || entry.outputs?.on_success !== policy.route_id) return null;
  entry.outputs.on_success = policy.normal_target;
  if (policy.normal_entry_config == null) delete entry.config;
  else entry.config = clone(policy.normal_entry_config);
  const trigger = clone(policy.normal_trigger_config);
  return { nodes, trigger_config: trigger, entry_node_id: template.entry_node_id, trigger_type: template.trigger_type };
}
function graphValid(template) {
  if (!EVENTS.includes(template?.trigger_type) || !single.scoped(template)) return false;
  const original = normalProjection(template), policy = template.trigger_config?.[POLICY];
  if (!original || C.hash(original) !== policy.normal_sha256) return false;
  const entry = json(template.nodes).find(node => node.id === template.entry_node_id);
  if (C.hash(entry?.config?.[POLICY]) !== C.hash(policy)) return false;
  const derived = { ...clone(policy.normal_trigger_config), [POLICY]: policy };
  if (C.hash(template.trigger_config) !== C.hash(derived)) return false;
  return branchValid({ nodes: json(template.nodes), entry_node_id: template.entry_node_id });
}
function branchValid({ nodes, entry_node_id }) {
  if (!Array.isArray(nodes) || new Set(nodes.map(node => node.id)).size !== nodes.length) return false;
  const entry = nodes.find(node => node.id === entry_node_id), policy = entry?.config?.[POLICY];
  const route = nodes.find(node => node.id === policy?.route_id);
  if (!entry || !EVENTS.some(event => entry.type === 'trigger/' + event) || entry.outputs?.on_success !== route?.id) return false;
  if (!Array.isArray(policy?.normal_ids) || !/^N\d+$/.test(policy.route_id)) return false;
  const expected = programNodes(Number(policy.route_id.slice(1)))[0]; expected.outputs.on_else = route.outputs?.on_else;
  const project = node => ({ id: node.id, type: node.type, outputs: node.outputs,
    mode: node.config?.mode, branches: node.config?.branch_rules?.map(branch => ({ id: branch.id,
      rules: branch.comparison_rules?.map(rule => ({ source: rule.left_ref?.source, path: rule.left_ref?.path,
        value_type: rule.left_ref?.value_type, operator: rule.operator, right_value: rule.right_value, connector: rule.connector ?? null })) })) });
  if (C.hash(project(route)) !== C.hash(project(expected)) || !nodes.some(node => node.id === route.outputs.on_else && policy.normal_ids.includes(node.id))) return false;
  const branch = nodes.filter(node => !policy.normal_ids.includes(node.id) && node.id !== route.id);
  if (nodes.some(node => node.type === C.ACTION && policy.normal_ids.includes(node.id))) return false;
  if (branch.filter(node => node.type === 'action/send_whatsapp').length !== 1
    || branch.filter(node => node.type === 'delay/wait_response').length !== 1) return false;
  // The branch stays modular, but cannot escape into a normal appointment's
  // state/attendance/consent actions. The typed resolver proves every mutation.
  return C.graphValid([{ id: 'PG_TRIGGER', type: 'trigger/' + C.REQUEST, config: {}, outputs: { on_success: route.outputs.branch_program } }, ...branch]);
}
function programNodes(start) {
  const reference = value => typeof value === 'string' ? value.replace(/\bN(\d+)\b/g, (_, id) => 'N' + (start + Number(id) - 1))
    : Array.isArray(value) ? value.map(reference) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, reference(item)])) : value;
  const nodes = C.definition().nodes.filter(node => node.id !== 'N1').map(node => {
    const result = reference(node);
    result.position = { x: (node.position?.x || 0) - 1200, y: (node.position?.y || 0) + 100 };
    return result;
  });
  nodes.find(node => node.id === 'N' + (start + 1)).config.language_code = '{{communication_language}}';
  const route = { id: 'N' + start, type: 'condition/field_check', position: { x: 0, y: 125 },
    config: { display_label: '¿Resumen de un programa?', mode: 'multi_branch', fallback_label: 'Cita individual', branch_rules: [
      { id: 'branch_program', label: 'Citas del programa', comparison_rules: [{ id: 'program_context', connector: null,
        left_ref: { source: 'context', path: 'program_confirmation.protocol', value_type: 'string' }, operator: 'equals', right_value: PROTOCOL }] },
    ] }, outputs: { branch_program: 'N' + (start + 1), on_else: null } };
  return [route, ...nodes];
}
function adapt(template) {
  if (!EVENTS.includes(template?.trigger_type) || !single.scoped(template) || !single.policyFor(template)) C.fail('program_details_native_family_invalid');
  if (template.trigger_config?.[POLICY]) {
    if (!graphValid(template)) C.fail('program_details_native_graph_changed');
    return clone(template);
  }
  const original = { nodes: clone(json(template.nodes)), trigger_config: clone(template.trigger_config || {}),
    entry_node_id: template.entry_node_id, trigger_type: template.trigger_type };
  const next = Math.max(0, ...original.nodes.map(node => /^N\d+$/.test(node.id) ? Number(node.id.slice(1)) : 0)) + 1;
  const result = { ...clone(template), ...clone(original) };
  const entry = result.nodes.find(node => node.id === result.entry_node_id);
  if (!entry?.outputs?.on_success || entry.type !== 'trigger/' + result.trigger_type) C.fail('program_details_native_entry_invalid');
  const target = entry.outputs.on_success;
  entry.outputs.on_success = 'N' + next;
  const additions = programNodes(next); additions[0].outputs.on_else = target;
  result.nodes.push(...additions);
  result.trigger_config[POLICY] = { revision: 1, configured: false, enabled_after: null,
    source_id: C.id(template.id),
    normal_target: target, normal_sha256: C.hash(original), protocol: PROTOCOL,
    route_id: 'N' + next, normal_ids: original.nodes.map(node => node.id),
    normal_trigger_config: clone(original.trigger_config), normal_entry_config: clone(entry.config ?? null) };
  entry.config = { ...(entry.config || {}), [POLICY]: result.trigger_config[POLICY] };
  return result;
}
function triggerConfig({ triggerType, entryNodeId, nodes }) {
  const policy = nodes?.find(node => node.id === entryNodeId)?.config?.[POLICY];
  const config = { ...clone(policy?.normal_trigger_config || {}), [POLICY]: policy };
  const key = { appointment_created: 'env_o_de_datos_de_la_cita_tras_agendar', appointment_rescheduled: 'envio_de_datos_de_la_cita_tras_agendar_copy' }[triggerType];
  if (!key || !policy || policy.protocol !== PROTOCOL || policy.revision !== 1
    || typeof policy.configured !== 'boolean' || policy.configured && !Number.isFinite(C.time(policy.enabled_after))
    || !graphValid({ trigger_type: triggerType, template_key: key, entry_node_id: entryNodeId, nodes, trigger_config: config })) C.fail('program_details_native_graph_changed');
  return config;
}
function configured(template, occurred) {
  const p = template?.trigger_config?.[POLICY];
  return graphValid(template) && p.configured === true && Number.isFinite(C.time(p.enabled_after))
    && C.time(occurred) >= C.time(p.enabled_after);
}
function timeout(template, { startAt, now, timeZone, reason }) {
  const original = normalProjection(template);
  if (!original || !graphValid(template)) C.fail('program_details_native_graph_changed');
  let send;
  if (template.trigger_type === 'appointment_rescheduled' && reason === 'patient_request') {
    const check = original.nodes.find(n => n.type === 'condition/field_check' && n.config?.mode === 'multi_branch'
      && n.config.branch_rules?.some(branch => branch.comparison_rules?.some(rule => rule.left_ref?.path === 'reschedule_reason' && rule.right_value === reason)));
    const branch = check?.config.branch_rules.find(b => b.comparison_rules?.some(r => r.left_ref?.path === 'reschedule_reason' && r.right_value === reason));
    send = original.nodes.find(n => n.id === check?.outputs?.[branch?.id]);
  } else {
    const timing = original.nodes.filter(n => n.type === 'condition/field_check' && n.config?.mode === 'appointment_booking_timing');
    if (timing.length !== 1) C.fail('program_details_native_wait_requires_review');
    const day = value => Date.parse(formatDateLocal(new Date(value), timeZone) + 'T00:00:00Z');
    const difference = Math.round((day(startAt) - day(now)) / 86400000);
    const window = difference === 0 ? 'same_day' : difference === 1 ? 'day_before' : 'more_than_day_before';
    const rule = timing[0].config.switch_rules.find(r => r.match_window === window);
    send = original.nodes.find(n => n.id === timing[0].outputs[rule?.id]);
  }
  const leg = Object.values(single.policyFor(template)?.retired_nodes || {}).find(value => value.first_send_node_id === send?.id);
  if (send?.type !== 'action/send_whatsapp' || !Number.isInteger(leg?.total_wait_minutes) || leg.total_wait_minutes < 1
    || leg.total_wait_minutes > 10080) C.fail('program_details_native_wait_requires_review');
  return leg.total_wait_minutes;
}
const enabled = () => process.env.PATIENT_PROGRAM_APPOINTMENT_AUTOMATION_ENABLED === 'true';
const programNode = (template, offset) => 'N' + (Number(template.trigger_config?.[POLICY]?.route_id?.slice(1)) + offset);
const programNodeIds = template => json(template.nodes).filter(node => !template.trigger_config?.[POLICY]?.normal_ids?.includes(node.id)).map(node => node.id);
module.exports = { POLICY, PROTOCOL, EVENTS, enabled, nativeFlow, operation, adapt, graphValid, branchValid, normalProjection, triggerConfig, configured, timeout, programNode, programNodeIds };
