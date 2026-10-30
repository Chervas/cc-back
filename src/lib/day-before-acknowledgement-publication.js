'use strict';
const native = require('./appointment-single-notice-publication');
const { inScope, adapt } = require('./day-before-acknowledgement-review');
const graph = row => ({ entry_node_id: row.entry_node_id, trigger_type: row.trigger_type, nodes: row.nodes });

function planEntry(source) {
  if (!inScope(source) || !source.published_at || !Number.isSafeInteger(Number(source.id))) return null;
  const next = { ...graph(source), nodes: adapt(source) };
  if (native.hash(graph(source)) === native.hash(next)) return null;
  return { source: structuredClone(source), source_hash: native.hash(graph(source)), graph_hash: native.hash(next),
    body: { acknowledgement_review_source_id: Number(source.id), name: source.name, description: source.description ?? null,
      template_key: source.template_key, clinic_id: source.clinic_id, group_id: source.group_id,
      is_system: source.is_system === true || source.is_system === 1, is_active: false, engine_version: 'v2',
      ...next, trigger_config: structuredClone(source.trigger_config) } };
}

module.exports = {
  hash: native.hash, planEntry,
  preservedNodes: (source, candidate) => native.preservedNodes(source, candidate, planEntry),
  validatePreservedNodeConfigs: (source, nodes, validate) => native.validatePreservedNodeConfigs(source, nodes, validate, planEntry),
  publishEntry: (entry, request) => native.publishEntry(entry, request, planEntry, 'acknowledgement_review_source_id'),
};
