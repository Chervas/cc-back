'use strict';

const { isDeepStrictEqual } = require('node:util');
const { AUTO_APPLY_CONFIDENCE_THRESHOLD } = require('./automation-intent-contract');
const FAMILY_KEY = 'recordatorio_mismo_d_a_sabes_llegar';
const BRANCH_ID = 'branch_no_action';
const END_ID = 'N75';
const EXIT_KEY = 'same_day_no_action_exit_v1';

function isSameDayDirectionsTemplate(source) {
  return source?.trigger_type === 'appointment_reminder_window'
    && (source.template_key === FAMILY_KEY || /^recordatorio_mismo_d_a_sabes_llegar__clinic_\d+$/.test(source.template_key || ''));
}

function addSameDayNoActionBranch(source) {
  if (!isSameDayDirectionsTemplate(source)) {
    throw Error('same_day_no_action_scope_invalid');
  }
  const nodes = structuredClone(source.nodes);
  const ai = nodes.find(n => n.id === 'N3');
  const comparator = nodes.find(n => n.id === 'N10');
  if (ai?.config?.preset_key !== 'classify_intent' || ai.outputs?.on_success !== 'N10'
    || comparator?.config?.mode !== 'multi_branch' || !Array.isArray(comparator.config.branch_rules)) {
    throw Error('same_day_no_action_comparator_invalid');
  }
  const ref = (path, value_type) => ({ source: 'node_output', node_id: 'N3', path, value_type,
    label: path === 'necesita_respuesta' ? 'Necesita respuesta' : path });
  const fields = [
    ['intencion_principal', 'string', 'equals', 'otra'],
    ['confianza_intencion_principal', 'number', 'greater_than', AUTO_APPLY_CONFIDENCE_THRESHOLD],
    ['necesita_respuesta', 'boolean', 'equals', false],
    ['confianza_necesita_respuesta', 'number', 'greater_than', AUTO_APPLY_CONFIDENCE_THRESHOLD],
  ];
  const branch = { id: BRANCH_ID, label: 'Respuesta sin actuación pendiente',
    left_ref: ref('intencion_principal', 'string'), operator: 'equals', right_value: 'otra',
    comparison_rules: fields.map(([path, type, operator, right_value], index) => ({
      id: 'rule_' + (index + 1), left_ref: ref(path, type), operator, right_value,
      connector: index ? 'and' : null,
    })) };
  const end = { id: END_ID, type: 'control/end', config: { migration_key: EXIT_KEY }, outputs: {},
    position: { x: 1700, y: 1440 } };
  const existing = comparator.config.branch_rules.find(n => n.id === BRANCH_ID);
  if (existing) {
    if (!isDeepStrictEqual(existing, branch)
      || comparator.outputs?.[BRANCH_ID] !== END_ID
      || nodes.find(n => n.id === END_ID)?.config?.migration_key !== EXIT_KEY) {
      throw Error('same_day_no_action_existing_branch_changed');
    }
    return nodes;
  }
  if (comparator.config.branch_rules.length >= 7) throw Error('same_day_no_action_branch_limit');
  if (nodes.some(n => n.id === END_ID)) throw Error('same_day_no_action_end_id_conflict');
  comparator.config.branch_rules.push(branch);
  comparator.outputs = { ...comparator.outputs, [BRANCH_ID]: END_ID };
  comparator.output_schema = { ...comparator.output_schema, [BRANCH_ID]: { label: branch.label } };
  nodes.push(end);
  return nodes;
}

function isExplicitSameDayNoActionExit(execution, classification, state = {}) {
  const context = execution?.context || {};
  const decision = context.outputs?.N10;
  const end = context.outputs?.[END_ID];
  return execution?.trigger_type === 'appointment_reminder_window'
    && isSameDayDirectionsTemplate(execution.templateVersion)
    && execution.status === 'completed'
    && decision?.next_output_key === BRANCH_ID
    && ['flow_ended', 'success'].includes(end?.status) && end?.resolution_key === EXIT_KEY
    && classification?.intencion_principal === 'otra'
    && classification.necesita_respuesta === false
    && Number(classification.confianza_intencion_principal) > AUTO_APPLY_CONFIDENCE_THRESHOLD
    && Number(classification.confianza_necesita_respuesta) > AUTO_APPLY_CONFIDENCE_THRESHOLD
    && classification.posible_urgencia !== true && !state.possible_urgency
    && !classification._ai_reference_inconsistent && !classification._ai_error_code
    && !['pregunta', 'cancelar_cita', 'solicitar_cambio_cita', 'urgencia_posible'].includes(classification.intencion_secundaria);
}

module.exports = { FAMILY_KEY, BRANCH_ID, END_ID, EXIT_KEY, isSameDayDirectionsTemplate,
  addSameDayNoActionBranch, isExplicitSameDayNoActionExit };
