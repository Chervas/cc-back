'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { addSameDayNoActionBranch, isExplicitSameDayNoActionExit, FAMILY_KEY, EXIT_KEY, BRANCH_ID } = require('../../lib/same-day-no-action-branch');

const source = () => ({ template_key: FAMILY_KEY, trigger_type: 'appointment_reminder_window',
  nodes: [{ id: 'N3', type: 'condition/ai_analysis', config: { preset_key: 'classify_intent', instruction: 'Preserved prompt' }, outputs: { on_success: 'N10' } },
    { id: 'N10', type: 'condition/field_check', config: { mode: 'multi_branch', branch_rules: [{ id: 'branch_ack' }] }, outputs: { on_else: 'N61', branch_ack: 'N62' } },
    { id: 'N61', type: 'action/send_system_notification', config: {}, outputs: {} }] });
const classification = () => ({ intencion_principal: 'otra', intencion_secundaria: '', necesita_respuesta: false,
  confianza_intencion_principal: 0.95, confianza_necesita_respuesta: 0.9, posible_urgencia: false });
const execution = () => ({ trigger_type: 'appointment_reminder_window', status: 'completed',
  templateVersion: { template_key: FAMILY_KEY, trigger_type: 'appointment_reminder_window' }, context: { outputs: {
  N10: { next_output_key: BRANCH_ID }, N75: { status: 'flow_ended', resolution_key: EXIT_KEY },
} } });

test('adds only one comparator branch and a silent end, without altering input, prompt or old outputs', () => {
  const original = source(), before = structuredClone(original);
  const nodes = addSameDayNoActionBranch(original);
  assert.deepEqual(original, before);
  assert.deepEqual(nodes[0], before.nodes[0]);
  assert.deepEqual(nodes[2], before.nodes[2]);
  assert.equal(nodes[1].config.branch_rules.length, 2);
  assert.equal(nodes[1].outputs.on_else, 'N61');
  assert.equal(nodes[1].outputs.branch_ack, 'N62');
  assert.equal(nodes[1].outputs[BRANCH_ID], 'N75');
  assert.equal(nodes[3].type, 'control/end');
  assert.deepEqual(addSameDayNoActionBranch({ ...original, nodes }), nodes);
  const reordered = value => Array.isArray(value) ? value.map(reordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)])) : value;
  assert.deepEqual(addSameDayNoActionBranch({ ...original, nodes: reordered(nodes) }), nodes);
});

test('cannot alter another family or a damaged/conflicting graph', () => {
  assert.throws(() => addSameDayNoActionBranch({ ...source(), template_key: 'day_before' }), /scope_invalid/);
  assert.throws(() => addSameDayNoActionBranch({ ...source(), trigger_type: 'message_received' }), /scope_invalid/);
  const graph = source(); graph.nodes.push({ id: 'N75', type: 'action/reply_message' });
  assert.throws(() => addSameDayNoActionBranch(graph), /end_id_conflict/);
});

test('only the explicit new end can resolve a confident no-action reply', () => {
  assert.equal(isExplicitSameDayNoActionExit(execution(), classification()), true);
  for (const patch of [{ trigger_type: 'appointment_created' }, { status: 'cancelled' },
    { templateVersion: { template_key: 'other', trigger_type: 'appointment_reminder_window' } },
    { context: { outputs: { N10: { next_output_key: 'on_else' }, N75: { status: 'flow_ended', resolution_key: EXIT_KEY } } } },
    { context: { outputs: { N10: { next_output_key: BRANCH_ID }, N75: { status: 'flow_ended' } } } }]) {
    assert.equal(isExplicitSameDayNoActionExit({ ...execution(), ...patch }, classification()), false);
  }
});

test('questions, uncertainty, urgency and inconsistent evidence cannot close through this exit', () => {
  for (const patch of [{ necesita_respuesta: true }, { confianza_necesita_respuesta: 0.85 },
    { confianza_intencion_principal: 0.85 }, { posible_urgencia: true }, { _ai_reference_inconsistent: true },
    { _ai_error_code: 'bedrock_timeout' }, { intencion_principal: 'pregunta' }, { intencion_secundaria: 'pregunta' }]) {
    assert.equal(isExplicitSameDayNoActionExit(execution(), { ...classification(), ...patch }), false);
  }
  assert.equal(isExplicitSameDayNoActionExit(execution(), classification(), { possible_urgency: true }), false);
});
