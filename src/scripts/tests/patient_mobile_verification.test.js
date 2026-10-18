'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../lib/patient-mobile-verification');
const { createRuntime } = require('../../services/patientMobileVerification.service');
const { loadSource } = require('./fixtures/business_profile_flow_runtime.fixture');

test('prepared V2 definition has no activation, deadline or appointment/marketing actions', () => {
  const f = C.definition();
  assert.equal(f.trigger_type, C.REQUEST);
  assert.equal(f.is_active, false); assert.equal(f.published_at, null);
  assert.equal(f.trigger_config.response_timeout_minutes, null);
  assert.equal(C.configValid(f.trigger_config), false);
  assert.equal(C.graphValid(f.nodes), true);
  assert.equal(C.definition(99).clinic_id, 99);
  assert.equal(C.definition(99).is_system, false);
  assert(!f.nodes.some(n => /appointment|consent|marketing|opt_out|classify_intent/.test(n.type)));
});
test('modular graph can add reusable notes and change routes without allowing unrelated side effects', () => {
  const original = C.definition().nodes;
  const nodes = structuredClone(original);
  nodes.find(n => n.id === 'N7').outputs.on_success = 'N14';
  nodes.push({ id: 'N14', type: 'action/write_note', config: { content: 'Móvil verificado' }, outputs: { on_success: 'N13' } });
  assert(C.graphValid(nodes));
  assert.equal(C.graphValid([...original, { id: 'N15', type: 'action/confirm_appointment' }]), false);
  assert.equal(C.graphValid(original.map(n => ({ ...n, id: 'duplicate' }))), false);
  assert.equal(C.graphValid(null), false);
  for (const patch of [{ communication_scope: 'marketing' }, { recipient_mode: 'manual_number' },
    { message_mode: 'manual' }, { template_name: 'another_template' }]) {
    const changed = structuredClone(original); Object.assign(changed[1].config, patch);
    assert.equal(C.graphValid(changed), false);
  }
});
test('deadline requires explicit positive whole minutes and a prospective cutoff', () => {
  for (const v of [null, 0, -1, 0.5, '1.5', 10081, true, Infinity, {}, []]) assert.equal(C.timeout(v), null);
  for (const v of [1, 60, '1440', 10080]) assert.equal(C.timeout(v), Number(v));
  assert(C.configValid({ configured: true, response_timeout_minutes: 60, enabled_after: '2026-10-18T10:00:00Z' }));
  assert(!C.configValid({ configured: true, response_timeout_minutes: 60, enabled_after: 'invalid' }));
});
test('only the approved Utility body and two exact reply buttons are accepted', () => {
  const valid = { category: 'UTILITY', status: 'APPROVED', is_active: true,
    components: [{ type: 'BODY', text: C.BODY }, { type: 'BUTTONS', buttons: C.BUTTONS.map(text => ({ type: 'QUICK_REPLY', text })) }] };
  assert(C.templateValid(valid));
  for (const patch of [{ category: 'MARKETING' }, { status: 'PENDING' }, { is_active: false }, { components: [] }]) assert(!C.templateValid({ ...valid, ...patch }));
  const wrong = structuredClone(valid); wrong.components[1].buttons[0].text = 'Confirmar cita';
  assert(!C.templateValid(wrong));
  const payload = 'pmv:10:' + 'a'.repeat(36) + ':yes';
  const details = require('../../lib/whatsappInboundDetails').details({ type: 'button',
    button: { payload, text: C.BUTTONS[0] }, context: { id: 'wamid.TESTONLY' } });
  assert.deepEqual(details, { button: { payload, text: C.BUTTONS[0] }, context: { id: 'wamid.TESTONLY' } });
});
test('auditable projection preserves history/provenance without exposing reply tokens', () => {
  const request = { id: 10, patient_id: 1, clinic_id: 2, metadata: { phone: '+34 600 000 001', reply_token: 'PRIVATE' } };
  const events = [{ id: 11, event_type: C.RESOLVED, occurred_at: '2026-10-18', actor_user_id: 5,
    metadata: { request_event_id: 10, state: 'confirmed', provenance: 'manual_review', actor_user_id: 5, manually_resolved: true } },
  { id: 12, metadata: { request_event_id: 20, state: 'review_required' } }];
  const state = C.stateFrom(request, events);
  assert.equal(state.state, 'confirmed'); assert.equal(state.revision, 11); assert.equal(state.phone, '34600000001');
  assert.equal(state.actor_user_id, 5); assert.equal(state.history.length, 1);
  assert(!JSON.stringify(state).includes('PRIVATE'));
});
test('simulation does not open a DB, create tasks or send transport', async () => {
  const db = { Sequelize: { Op: {} } };
  const runtime = createRuntime({ db });
  for (const name of ['resolveAction']) {
    const result = await runtime[name]({ node: { config: { result: 'confirmed', reason: '' }, outputs: {} }, context: { __simulation: true } });
    assert.equal(result.kind, 'success');
  }
  for (const metadata of [{ kind: 'patient_mobile_verification' }, { mobile_verification_request_id: 'invalid' }, { mobile_verification_request_id: 0 }]) {
    assert.equal((await runtime.authorizeTransport({ message: { metadata } })).allowed, false);
  }
});
test('native V2 registry accepts modular composition and does not require the old bespoke nodes', async () => {
  const template = { id: 117, name: C.TEMPLATE, locale: 'es', components: [
    { type: 'BODY', text: C.BODY }, { type: 'BUTTONS', buttons: C.BUTTONS.map(text => ({ type: 'QUICK_REPLY', text })) }],
    variables: [{ position: 1, name: 'nombre_clinica' }] };
  const controller = loadSource('../controllers/automationsV2.controller', { '../../models': {
    Sequelize: require('sequelize'), WhatsappTemplate: { findAll: async () => [] },
    WhatsappTemplateCatalog: { findAll: async () => [template] },
  } }, {}, 10000);
  const draft = await controller.validateFlowPayloadForInternalUse(C.definition());
  assert.equal(draft.ok, true, JSON.stringify(draft)); assert.equal(draft.trigger_type, C.REQUEST); assert.equal(draft.trigger_config.configured, false);
  const configured = C.definition(); configured.nodes[0].config = { response_timeout_minutes: 60, enabled_after: '2026-10-20T12:00:00Z' };
  assert.equal((await controller.validateFlowPayloadForInternalUse(configured)).trigger_config.configured, true);
  configured.nodes[0].config.response_timeout_minutes = -1;
  assert.equal((await controller.validateFlowPayloadForInternalUse(configured)).ok, false);
  const rewired = C.definition(); rewired.nodes[2].outputs.on_response = 'N2';
  assert.equal((await controller.validateFlowPayloadForInternalUse(rewired)).ok, false);
  const extended = C.definition(); extended.nodes.find(n => n.id === 'N7').outputs.on_success = 'N14';
  extended.nodes.push({ id: 'N14', type: 'action/write_note', config: { content: 'Móvil verificado' }, outputs: { on_success: 'N13' } });
  assert.equal((await controller.validateFlowPayloadForInternalUse(extended)).ok, true);
  let meta; await controller.getFlowMeta({}, { json: v => { meta = v.data; } });
  assert(meta.triggers.some(t => t.value === C.REQUEST && t.label === 'Verificación de cambio de móvil'));
  assert.equal(meta.node_types.filter(n => n.type.includes('mobile_verification')).length, 2);
  for (const type of ['action/send_whatsapp', 'delay/wait_response', 'condition/ai_analysis',
    'condition/field_check', 'action/send_system_notification', C.RESULT_ACTION]) {
    assert(meta.node_types.some(n => n.type === type));
    assert(draft.nodes.some(n => n.type === type));
  }
});

test('the existing multi-branch comparator handles buttons and conservative AI results, not new bespoke decisions', async () => {
  const engine = loadSource('flowEngineV2.service', { '../../models': { Sequelize: require('sequelize') },
    './jobRequests.service': { getCurrentRuntimeNamespace: () => 'TESTONLY' } }, {}, 10000);
  const flow = C.definition(), explicit = flow.nodes.find(n => n.id === 'N4'), analysis = flow.nodes.find(n => n.id === 'N6');
  const run = (node, context) => engine._processNode(node, { __simulation: true, ...context }, { simulation: true });
  for (const [reply_answer, expected] of [['yes', 'N7'], ['no', 'N8'], ['', 'N5'], ['sí', 'N5'], ['thanks', 'N5']]) {
    assert.equal((await run(explicit, { mobile_verification: { reply_answer } })).next_node_id, expected);
  }
  let combinations = 0;
  for (const intent of ['correct', 'incorrect', 'unclear', '', 'confirm_appointment']) {
    for (const confidence of [0, 0.5, 0.89, 0.9, 1]) for (const unequivocal of [true, false]) for (const evidence of ['', 'Mi número es correcto']) {
      const expected = unequivocal && confidence >= 0.9 && evidence
        ? intent === 'correct' ? 'N7' : intent === 'incorrect' ? 'N8' : 'N9' : 'N9';
      assert.equal((await run(analysis, { outputs: { N5: { intent, confidence, unequivocal, evidence } } })).next_node_id, expected);
      combinations++;
    }
  }
  assert.equal(combinations, 100);
});

test('module uses existing broker AI scope and a local mobile-specific instruction, not appointment prompts', () => {
  const node = C.definition().nodes.find(n => n.type === 'condition/ai_analysis');
  assert(require('../../../services/integrations-broker/src/bedrock-limits').USE_CASES.includes(C.AI_PRESET));
  assert.equal(node.config.preset_key, 'custom');
  assert.equal(node.config.instruction, C.AI_INSTRUCTION);
  assert.equal(node.config.context_sources.length, 2);
  assert(node.config.context_sources.every(source => !/conversation_|appointment/.test(source.path)));
  assert(node.config.instruction.includes('Ante cualquier duda'));
});
