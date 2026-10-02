'use strict';

const CANONICAL_PILOT_PUBLIC_ID = 'flw_0b8af554f77d0f0f';
const CANONICAL_CATALOG_NAME = 'recordatorio_mismo_dia_a_las_8_sabes_llegar';
const CANONICAL_SNAPSHOT_KEY = 'same_day_bs_capilar_canonical_v1';
const DELIVERY_NODE_IDS = ['N1', 'N2', 'N6', 'N7', 'N8', 'N9'];

function buildCanonicalSameDayFlow(source, pilot) {
  if (pilot?.public_id !== CANONICAL_PILOT_PUBLIC_ID || Number(pilot?.version) !== 10
    || Number(pilot?.clinic_id) !== 66 || source?.clinic_id != null || source?.group_id != null) {
    throw new Error('same_day_canonical_scope_mismatch');
  }
  if (source.trigger_type !== 'appointment_reminder_window' || pilot.trigger_type !== source.trigger_type) {
    throw new Error('same_day_canonical_trigger_mismatch');
  }
  const nodes = structuredClone(pilot.nodes);
  const sourceNodes = new Map(source.nodes.map((node) => [node.id, node]));
  for (const id of DELIVERY_NODE_IDS) {
    const index = nodes.findIndex((node) => node.id === id);
    if (index < 0 || !sourceNodes.has(id)) throw new Error('same_day_canonical_delivery_node_missing');
    nodes[index] = structuredClone(sourceNodes.get(id));
  }
  const classifier = nodes.find((node) => node.id === 'N3');
  const comparator = nodes.find((node) => node.id === 'N10');
  if (classifier?.config?.preset_key !== 'classify_intent' || classifier?.outputs?.on_success !== 'N10'
    || comparator?.config?.mode !== 'multi_branch' || comparator.config.branch_rules?.length !== 6) {
    throw new Error('same_day_canonical_comparator_invalid');
  }
  return {
    trigger_type: source.trigger_type,
    trigger_config: structuredClone(source.trigger_config),
    entry_node_id: source.entry_node_id,
    nodes,
  };
}

module.exports = {
  CANONICAL_PILOT_PUBLIC_ID, CANONICAL_CATALOG_NAME, CANONICAL_SNAPSHOT_KEY,
  DELIVERY_NODE_IDS, buildCanonicalSameDayFlow,
};
