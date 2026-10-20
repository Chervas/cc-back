'use strict';
const native = require('./appointment-single-notice-publication');
const { updateAppointmentMessages } = require('./appointment-message-copy');
const graph = row => ({ entry_node_id: row.entry_node_id, trigger_type: row.trigger_type, nodes: row.nodes });

function planEntry(source) {
  if (!['appointment_created', 'appointment_rescheduled', 'appointment_reminder_window'].includes(source.trigger_type)
    || !source.published_at || !Number.isSafeInteger(Number(source.id)) || Number(source.id) <= 0) return null;
  const next = updateAppointmentMessages(source);
  if (native.hash(graph(source)) === native.hash(graph(next))) return null;
  return { source: structuredClone(source), source_hash: native.hash(graph(source)), graph_hash: native.hash(graph(next)),
    body: { message_copy_source_id: source.id, name: source.name, description: source.description ?? null,
      template_key: source.template_key, clinic_id: source.clinic_id, group_id: source.group_id,
      is_system: source.is_system === true, is_active: false, engine_version: 'v2',
      ...graph(next), trigger_config: structuredClone(source.trigger_config) } };
}

module.exports = {
  hash: native.hash, planEntry,
  preservedNodes: (source, candidate) => native.preservedNodes(source, candidate, planEntry),
  validatePreservedNodeConfigs: (source, nodes, validate) => native.validatePreservedNodeConfigs(source, nodes, validate, planEntry),
  publishEntry: (entry, request) => native.publishEntry(entry, request, planEntry, 'message_copy_source_id'),
};
