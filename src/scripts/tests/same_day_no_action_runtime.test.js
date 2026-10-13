'use strict';
process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';
const test = require('node:test');
const assert = require('node:assert/strict');
const queuePath = require.resolve('../../services/queue.service');
require.cache[queuePath] = { id: queuePath, filename: queuePath, loaded: true,
  exports: { queues: {}, createWorker: () => { throw Error('Workers forbidden in this simulation'); } } };
const db = require('../../../models');
const engine = require('../../services/flowEngineV2.service');
const attention = require('../../services/conversationAutomationState.service');
const { addSameDayNoActionBranch, FAMILY_KEY, EXIT_KEY } = require('../../lib/same-day-no-action-branch');

const ref = (path, type) => ({ source: 'node_output', node_id: 'N3', path, value_type: type });
const source = { template_key: FAMILY_KEY, trigger_type: 'appointment_reminder_window', nodes: [
  { id: 'N3', type: 'condition/ai_analysis', config: { preset_key: 'classify_intent' }, outputs: { on_success: 'N10' } },
  { id: 'N10', type: 'condition/field_check', config: { mode: 'multi_branch', branch_rules: [{
    id: 'needs', left_ref: ref('necesita_respuesta', 'boolean'), operator: 'equals', right_value: true,
  }] }, outputs: { needs: 'N60', on_else: 'N61' } },
] };
const base = () => ({ intencion_principal: 'otra', intencion_secundaria: '', necesita_respuesta: false,
  confianza_intencion_principal: 0.95, confianza_necesita_respuesta: 0.9, posible_urgencia: false });

test('native comparator routes a confident no-action result to a silent end, not a notification', async () => {
  const nodes = addSameDayNoActionBranch(source);
  const branch = nodes.find(n => n.id === 'N10');
  const result = await engine._processNode(branch, { outputs: { N3: base() } }, { simulation: true });
  assert.equal(result.next_node_id, 'N75');
  const end = await engine._processNode(nodes.find(n => n.id === 'N75'), {}, { simulation: true });
  assert.equal(end.next_node_id, null);
  assert.equal(end.output.resolution_key, EXIT_KEY);
  for (const patch of [{ necesita_respuesta: true }, { confianza_intencion_principal: 0.85 },
    { confianza_necesita_respuesta: 0.85 }, { intencion_principal: 'pregunta' }]) {
    assert.notEqual((await engine._processNode(branch, { outputs: { N3: { ...base(), ...patch } } }, { simulation: true })).next_node_id, 'N75');
  }
});

test('native finalization closes only the explicit new exit and preserves old, urgent and uncertain reviews', async t => {
  const original = { find: db.ConversationAutomationState.findOne, appointment: db.CitaPaciente.findByPk,
    complete: attention.completeState, update: attention.updateOwnedState, query: db.sequelize.query };
  t.after(() => { db.ConversationAutomationState.findOne = original.find; db.CitaPaciente.findByPk = original.appointment;
    attention.completeState = original.complete; attention.updateOwnedState = original.update; db.sequelize.query = original.query; });
  const results = [];
  db.sequelize.query = async () => { throw Error('SQL forbidden in this simulation'); };
  db.ConversationAutomationState.findOne = async () => ({ execution_id: 9001, manual_action_required: true,
    needs_response: false, source_message_id: 0, appointment_id: 91 });
  db.CitaPaciente.findByPk = async () => ({ id_cita: 91, estado: 'recordatorio_confirmado' });
  attention.completeState = async params => results.push({ result: 'completed', params });
  attention.updateOwnedState = async params => results.push({ result: 'review', params });
  const execution = (output = base()) => ({ id: 9001, clinic_id: 35, trigger_type: 'appointment_reminder_window',
    templateVersion: { template_key: FAMILY_KEY + '__clinic_35', trigger_type: 'appointment_reminder_window' },
    status: 'completed', context: { conversation: { id: 7 }, appointment: { id: 91 }, outputs: {
      N3: output, N10: { next_output_key: 'branch_no_action', status: 'success' },
      N75: { status: 'success', resolution_key: EXIT_KEY },
    } } });
  await engine._syncConversationAutomationStateAfterExecution(execution());
  assert.equal(results.at(-1).result, 'completed');
  assert.equal(results.at(-1).params.needsResponse, false);
  const old = execution(); delete old.context.outputs.N75;
  await engine._syncConversationAutomationStateAfterExecution(old);
  assert.equal(results.at(-1).result, 'review');
  const foreign = execution(); foreign.trigger_type = 'appointment_created';
  await engine._syncConversationAutomationStateAfterExecution(foreign);
  assert.equal(results.at(-1).result, 'review');
  for (const patch of [{ posible_urgencia: true }, { necesita_respuesta: true }, { _ai_reference_inconsistent: true },
    { confianza_necesita_respuesta: 0.85 }]) {
    await engine._syncConversationAutomationStateAfterExecution(execution({ ...base(), ...patch }));
    assert.equal(results.at(-1).result, 'review');
  }
});

test('the native AI node enables independent written evidence only for the same-day family', async t => {
  const ai = require('../../services/aiOrchestrator.service');
  const { cloneClassifyIntentPresetConfig } = require('../../lib/automation-intent-contract');
  const original = ai.analyzeStructured;
  t.after(() => { ai.analyzeStructured = original; });
  const requests = [];
  ai.analyzeStructured = async request => {
    requests.push(request);
    return { intencion_principal: 'confirmar_cita', intencion_secundaria: '', confianza_intencion_principal: .99,
      confianza_intencion_secundaria: .99, confianza: .99, accion_inequivoca: true,
      lectura_respuesta: 'compromiso_asistencia', confianza_lectura_respuesta: .99,
      asunto_preguntado: 'indicaciones', evidencia_decision_actual: 'Alli estare',
      decision_pospuesta: false, confianza_decision_pospuesta: .99,
      requiere_verificar_gestion_o_condicion: false, confianza_requiere_verificar_gestion_o_condicion: .99,
      hay_asunto_por_resolver: false, confianza_hay_asunto_por_resolver: .99,
      necesita_respuesta: false, confianza_necesita_respuesta: .99, posible_urgencia: false };
  };
  const node = { id: 'N3', type: 'condition/ai_analysis', config: cloneClassifyIntentPresetConfig(), outputs: { on_success: 'N10' } };
  const context = { trigger: { data: { appointment_candidate_count: 1 } }, last_response_context: { response_message_id: 87,
    listened_message_preview: 'Do you know how to get here?', response_text: 'Alli estare, conozco el camino',
    response_items: [{ message_id: 87, content_type: 'text', text: 'Alli estare, conozco el camino' }] } };
  for (const [template_key, expected] of [[FAMILY_KEY + '__clinic_35', 'confirmar_cita'],
    ['recordatorio_y_confirmacion_bed4b6__clinic_66', 'otra'], [FAMILY_KEY + '__clinic_35_copy_1', 'otra']]) {
    const result = await engine._processNode(node, context, { execution: {
      templateVersion: { template_key, trigger_type: 'appointment_reminder_window' },
    } });
    assert.equal(result.output.intencion_principal, expected, JSON.stringify(result.output));
  }
  assert.equal(requests.length, 3);
  assert.equal(requests[0].prompt, requests[1].prompt);
  assert.equal(requests[0].prompt, requests[2].prompt);
});

test.after(async () => { await db.sequelize.close(); });
