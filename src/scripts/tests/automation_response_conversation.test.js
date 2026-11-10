'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ownedResponseConversation } = require('../../lib/automation-response-conversation');

function fixture(overrides = {}) {
  const message = { id: 101, conversation_id: 502, direction: 'inbound', ...overrides.message };
  const conversation = { id: 502, clinic_id: 31, patient_id: 41, lead_id: null, ...overrides.conversation };
  const state = { conversation_id: 502, clinic_id: 31, execution_id: 1001, source_message_id: 101, ...overrides.state };
  return { Message: { findByPk: async () => message }, Conversation: { findByPk: async () => conversation },
    ConversationAutomationState: { findOne: async options => {
      assert.deepEqual(options.where, { conversation_id: 502, clinic_id: 31, execution_id: 1001, source_message_id: 101 });
      return state;
    } } };
}
const execution = { id: 1001, clinic_id: 31 };
const context = { conversation: { id: 501, patient_id: 41 },
  appointment: { paciente_id: 41 }, last_response_context: { response_message_id: 101 } };

test('attention follows an owned reply in the same patient and clinic after a number change', async () => {
  const before = JSON.stringify(context);
  const result = await ownedResponseConversation(fixture(), execution, context, 501);
  assert.equal(result.conversationId, 502);
  assert.equal(result.state.execution_id, 1001);
  assert.equal(JSON.stringify(context), before, 'AI evidence and the historical conversation remain intact');
});

for (const [name, overrides] of [
  ['outbound', { message: { direction: 'outbound' } }],
  ['original chat', { message: { conversation_id: 501 } }],
  ['other clinic', { conversation: { clinic_id: 32 } }],
  ['other patient', { conversation: { patient_id: 42 } }],
  ['unowned contact', { conversation: { patient_id: null } }],
  ['other execution', { state: { execution_id: 1002 } }],
  ['another state clinic', { state: { clinic_id: 32 } }],
  ['another state conversation', { state: { conversation_id: 503 } }],
  ['a newer reply', { state: { source_message_id: 102 } }],
]) test(`attention never follows ${name}`, async () => {
  assert.equal(await ownedResponseConversation(fixture(overrides), execution, context, 501), null);
});

test('a nickname or a missing source message cannot resolve an attention target', async () => {
  const noRead = { Message: { findByPk: () => { throw Error('Unexpected read'); } } };
  assert.equal(await ownedResponseConversation(noRead, execution, { username: 'same-nickname' }, 501), null);
  assert.equal(await ownedResponseConversation(fixture(), execution,
    { last_response_context: { response_message_id: 101 } }, 501), null);
});

test('the native finalizer settles the owned reply instead of leaving collecting forever', async t => {
  const db = require('../../../models');
  const engine = require('../../services/flowEngineV2.service');
  const attention = require('../../services/conversationAutomationState.service');
  const owned = { conversation_id: 502, clinic_id: 31, execution_id: 1001,
    source_message_id: 101, status: 'active', stage: 'collecting', appointment_id: 901 };
  t.mock.method(db.ConversationAutomationState, 'findOne', async options =>
    options.where.conversation_id === 502 ? owned : null);
  t.mock.method(db.Message, 'findByPk', async () => ({ id: 101, conversation_id: 502, direction: 'inbound' }));
  t.mock.method(db.Message, 'findAll', async () => []);
  t.mock.method(db.sequelize, 'query', async () => []);
  t.mock.method(db.Conversation, 'findByPk', async () => ({ id: 502, clinic_id: 31, patient_id: 41 }));
  t.mock.method(db.CitaPaciente, 'findByPk', async () => ({ id_cita: 901, estado: 'info_enviada' }));
  const writes = [];
  t.mock.method(attention, 'updateOwnedState', async (params, options) => writes.push({ params, options }));
  t.mock.method(attention, 'completeState', async () => { throw Error('Manual review must remain pending'); });
  const nodes = [{ id: 'analysis', type: 'condition/ai_analysis', config: { preset_key: 'confirm_appointment' } }];
  await engine._syncConversationAutomationStateAfterExecution({ ...execution, status: 'completed', context: {
    ...context, appointment: { paciente_id: 41, id_cita: 901 }, outputs: { analysis: {
      confirma_asistencia: false, confianza_confirma_asistencia: 0,
      requiere_respuesta: true, confianza_requiere_respuesta: 0.95,
    } },
  } }, { nodes });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].params.conversationId, 502);
  assert.equal(writes[0].params.stage, 'review');
  assert.equal(writes[0].params.manualActionRequired, true);
  assert.equal(writes[0].options.expectedExecutionId, 1001);
  assert.equal(writes[0].options.expectedSourceMessageId, 101);
});

test('settling a changed-phone reply cannot overwrite a newer source message', async t => {
  const db = require('../../../models');
  const service = require('../../services/conversationAutomationState.service');
  let where;
  t.mock.method(db.ConversationAutomationState, 'update', async (_patch, options) => {
    where = options.where;
    return [0]; // The source advanced to another message before the CAS.
  });
  t.mock.method(db.ConversationAutomationState, 'findOne', () => { throw Error('No stale row may be emitted'); });
  const result = await service.updateOwnedState({ clinicId: 31, conversationId: 502,
    stage: 'review' }, { expectedExecutionId: 1001, expectedSourceMessageId: 101 });
  assert.equal(result, null);
  assert.deepEqual(where, { conversation_id: 502, clinic_id: 31, execution_id: 1001, source_message_id: 101 });
});
