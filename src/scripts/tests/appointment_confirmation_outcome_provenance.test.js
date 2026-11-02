'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveConfirmAppointmentConversationOutcome: resolve } = require('../../services/flowEngineV2.service');
const { cloneConfirmAppointmentDecisionConfig } = require('../../lib/automation-intent-contract');
const nodes = [
  { id: 'ai', type: 'condition/ai_analysis', outputs: { on_success: 'decision' } },
  { id: 'decision', type: 'condition/field_check', config: cloneConfirmAppointmentDecisionConfig('ai') },
  { id: 'programme', type: 'condition/field_check', config: { mode: 'multi_branch' } },
];
const fixture = (branch = 'branch_confirm_without_reply', extra = {}) => ({ outputs: {
  ai: { at: '2030-01-01T09:00:00Z', confirma_asistencia: true, requiere_respuesta: false },
  decision: { at: '2030-01-01T09:00:01Z', next_output_key: branch },
  programme: { at: '2030-01-01T08:00:00Z', next_output_key: 'on_else', rule_results: [{ id: 'programme_booked', matched: false }] },
  ...extra,
} });

test('a programme fallback cannot turn an applied simple confirmation into manual review', () => {
  for (const reorder of [x => x, x => Object.fromEntries(Object.entries(x).reverse()),
    x => Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))]) {
    const context = fixture(); context.outputs = reorder(context.outputs);
    const original = JSON.stringify(context);
    assert.deepEqual(resolve(context, nodes), { branch: 'branch_confirm_without_reply', intent: 'confirmar_cita', needsResponse: false, manualActionRequired: false });
    assert.equal(JSON.stringify(context), original);
  }
});

test('the owning fallback, negative answer and secondary question retain manual review', () => {
  for (const branch of ['on_else', 'branch_not_confirmed', 'branch_confirm_needs_reply']) {
    const context = fixture(branch);
    context.outputs.ai.confirma_asistencia = branch === 'branch_confirm_needs_reply';
    context.outputs.ai.requiere_respuesta = branch === 'branch_confirm_needs_reply';
    const result = resolve(context, nodes);
    assert.equal(result.branch, branch); assert.equal(result.manualActionRequired, true);
    assert.equal(result.needsResponse, context.outputs.ai.requiere_respuesta);
  }
});

test('even a misleading named output from another comparator cannot override the owning fallback', () => {
  const context = fixture('on_else'); context.outputs.programme.next_output_key = 'branch_confirm_without_reply';
  assert.equal(resolve(context, nodes).branch, 'on_else');
  assert.equal(resolve(context, nodes).manualActionRequired, true);
});

test('multiple analyses use timestamp and graph ownership, never JSON key order', () => {
  const graph = [...nodes,
    { id: 'laterAi', type: 'condition/ai_analysis', outputs: { on_success: 'laterDecision' } },
    { id: 'laterDecision', type: 'condition/field_check', config: cloneConfirmAppointmentDecisionConfig('laterAi') }];
  const context = fixture();
  context.outputs.laterAi = { at: '2030-01-01T10:00:00Z', confirma_asistencia: false, requiere_respuesta: true };
  context.outputs.laterDecision = { at: '2030-01-01T10:00:01Z', next_output_key: 'branch_not_confirmed' };
  context.outputs = Object.fromEntries(Object.entries(context.outputs).reverse());
  assert.deepEqual(resolve(context, graph), { branch: 'branch_not_confirmed', intent: 'otra', needsResponse: true, manualActionRequired: true });
});

test('missing or contradictory graph ownership never clears review', () => {
  const context = fixture();
  assert.equal(resolve(context, []).manualActionRequired, true);
  const graph = structuredClone(nodes); graph[1].config.source_ai_node_id = 'otherAi';
  assert.equal(resolve(context, graph).manualActionRequired, true);
  delete context.outputs.decision;
  assert.equal(resolve(context, nodes).manualActionRequired, true);
});

test('legacy output evidence excludes unrelated generic fallback and preserves genuine fallback', () => {
  assert.equal(resolve(fixture()).manualActionRequired, false);
  const context = fixture('on_else');
  context.outputs.decision.rule_results = [{ id: 'branch_confirm_without_reply', matched: false }];
  assert.equal(resolve(context).manualActionRequired, true);
  assert.equal(resolve({ outputs: { ai: fixture().outputs.ai, decision: { next_output_key: 'on_else' } } }).manualActionRequired, true);
});

test('ambiguous historical analyses are conservative and absence of confirmation remains unrelated', () => {
  const context = fixture(); context.outputs.otherAi = { confirma_asistencia: true, requiere_respuesta: false };
  assert.equal(resolve(context, nodes).manualActionRequired, true);
  assert.equal(resolve({ outputs: { programme: context.outputs.programme } }, nodes), null);
});
