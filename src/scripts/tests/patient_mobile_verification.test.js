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
test('exact readable topology cannot be rewired, duplicated or extended with another workflow', () => {
  const original = C.definition().nodes;
  for (const index of [0, 1, 2, 3, 4]) {
    const nodes = structuredClone(original);
    nodes[index].outputs = { on_success: 'N1' };
    assert.equal(C.graphValid(nodes), false);
  }
  assert.equal(C.graphValid([...original, { id: 'N6', type: 'action/confirm_appointment' }]), false);
  assert.equal(C.graphValid(original.map(n => ({ ...n, id: 'duplicate' }))), false);
  assert.equal(C.graphValid(null), false);
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
  for (const name of ['requestAction', 'waitAction', 'reviewAction']) {
    const result = await runtime[name]({ node: { outputs: {} }, context: { __simulation: true } });
    assert.equal(result.kind, 'success');
  }
  for (const metadata of [{ kind: 'patient_mobile_verification' }, { mobile_verification_request_id: 'invalid' }, { mobile_verification_request_id: 0 }]) {
    assert.equal((await runtime.authorizeTransport({ message: { metadata } })).allowed, false);
  }
});
test('native V2 registry and validator accept the new trigger, preserve draft and reject rewired graphs', async () => {
  const controller = loadSource('../controllers/automationsV2.controller', { '../../models': { Sequelize: require('sequelize') } }, {}, 10000);
  const draft = await controller.validateFlowPayloadForInternalUse(C.definition());
  assert.equal(draft.ok, true); assert.equal(draft.trigger_type, C.REQUEST); assert.equal(draft.trigger_config.configured, false);
  const configured = C.definition(); configured.nodes[0].config = { response_timeout_minutes: 60, enabled_after: '2026-10-20T12:00:00Z' };
  assert.equal((await controller.validateFlowPayloadForInternalUse(configured)).trigger_config.configured, true);
  configured.nodes[0].config.response_timeout_minutes = -1;
  assert.equal((await controller.validateFlowPayloadForInternalUse(configured)).ok, false);
  const rewired = C.definition(); rewired.nodes[2].outputs.on_confirmed = 'N2';
  assert.equal((await controller.validateFlowPayloadForInternalUse(rewired)).ok, false);
  let meta; await controller.getFlowMeta({}, { json: v => { meta = v.data; } });
  assert(meta.triggers.some(t => t.value === C.REQUEST && t.label === 'Verificación de cambio de móvil'));
  assert.equal(meta.node_types.filter(n => n.type.includes('mobile_verification')).length, 4);
});
