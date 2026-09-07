'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const db = require('../../../models');
const {
  RESOLUTION_CONFIDENCE,
  classifyLatePatientFollowUp,
  messageWasRevoked,
  reconcilePendingAutomationAttentionForInboundMessage,
} = require('../../services/automationAttentionReconciliation.service');

test('reconoce metadatos de mensajes revocados de coexistencia', () => {
  assert.equal(messageWasRevoked({ coexistence: { last_event: 'revoke' } }), true);
  assert.equal(messageWasRevoked(JSON.stringify({ revoke: { at: '2026-09-07T11:51:47Z' } })), true);
  assert.equal(messageWasRevoked({ coexistence: { last_event: 'message' } }), false);
});

test('clasifica el seguimiento tardío con el contrato conservador', async () => {
  const result = await classifyLatePatientFollowUp({
    state: {
      intent: 'otra',
      needs_response: true,
      appointment_id: 75017,
      appointment_status: 'info_enviada',
    },
    messages: [
      {
        id: 107279,
        direction: 'inbound',
        message_type: 'text',
        content: 'Con su cp',
        metadata: { coexistence: { last_event: 'revoke' } },
      },
      {
        id: 107291,
        direction: 'inbound',
        message_type: 'text',
        content: 'Ya tengo la dirección, muchas gracias',
        metadata: {},
      },
    ],
    clinicId: 19,
    classifier: async (request) => {
      assert.equal(request.useCase, 'automation_attention_late_follow_up');
      assert.match(request.systemPrompt, /nunca basta por sí solo/);
      assert.match(request.inputText, /Ya tengo la dirección/);
      return {
        decision: 'resolved_by_patient',
        confidence: 0.98,
        reason: 'La paciente indica que ya encontró la dirección.',
        _ai_provider: 'bedrock',
        _ai_model: 'test-model',
      };
    },
  });

  assert.equal(result.decision, 'resolved_by_patient');
  assert.equal(result.confidence, 0.98);
});

test('cierra estado y avisos cuando el paciente resuelve explícitamente la petición tardía', async (t) => {
  const originalStateFindOne = db.ConversationAutomationState.findOne;
  const originalMessageFindAll = db.Message.findAll;
  t.after(() => {
    db.ConversationAutomationState.findOne = originalStateFindOne;
    db.Message.findAll = originalMessageFindAll;
  });

  db.ConversationAutomationState.findOne = async () => ({
    clinic_id: 19,
    conversation_id: 9582,
    stage: 'review',
    status: 'review',
    source_message_id: 107279,
    execution_id: 2320,
    appointment_id: 75017,
    appointment_status: 'info_enviada',
    intent: 'otra',
    possible_urgency: false,
    needs_response: true,
    manual_action_required: true,
  });
  db.Message.findAll = async () => [
    {
      id: 107291,
      direction: 'inbound',
      content: 'Ya tengo la dirección, muchas gracias',
      message_type: 'text',
      metadata: {},
    },
    {
      id: 107279,
      direction: 'inbound',
      content: 'Con su cp',
      message_type: 'text',
      metadata: { coexistence: { last_event: 'revoke' } },
    },
  ];
  const updatedMessages = [];
  const message = {
    id: 107291,
    conversation_id: 9582,
    direction: 'inbound',
    message_type: 'text',
    content: 'Ya tengo la dirección, muchas gracias',
    metadata: {},
    update: async (patch) => updatedMessages.push(patch),
  };
  const completedStates = [];
  const resolvedNotifications = [];

  const result = await reconcilePendingAutomationAttentionForInboundMessage({
    conversation: { id: 9582, clinic_id: 19 },
    message,
    classifier: async () => ({
      decision: 'resolved_by_patient',
      confidence: RESOLUTION_CONFIDENCE,
      reason: 'Ya no necesita la dirección.',
    }),
    stateCompleter: async (params, options) => {
      completedStates.push({ params, options });
      return params;
    },
    notificationResolver: async (...args) => {
      resolvedNotifications.push(args);
      return { success: true, updated: 2 };
    },
  });

  assert.equal(result.resolved, true);
  assert.equal(result.notifications_updated, 2);
  assert.deepEqual(completedStates, [{
    params: {
      clinicId: 19,
      conversationId: 9582,
      sourceMessageId: 107291,
      needsResponse: false,
    },
    options: { expectedExecutionId: 2320 },
  }]);
  assert.equal(resolvedNotifications[0][0], 9582);
  assert.equal(resolvedNotifications[0][2].reason, 'patient_followup_resolved');
  assert.equal(updatedMessages[0].metadata.automation_attention_reconciliation.decision, 'resolved_by_patient');
  assert.equal(updatedMessages[0].metadata.automation_attention_reconciliation.applied, true);
});

test('no cierra la revisión con baja confianza ni estados urgentes', async (t) => {
  const originalStateFindOne = db.ConversationAutomationState.findOne;
  const originalMessageFindAll = db.Message.findAll;
  t.after(() => {
    db.ConversationAutomationState.findOne = originalStateFindOne;
    db.Message.findAll = originalMessageFindAll;
  });

  const state = {
    clinic_id: 19,
    conversation_id: 9582,
    stage: 'review',
    status: 'review',
    source_message_id: 107279,
    execution_id: 2320,
    appointment_id: null,
    intent: 'otra',
    possible_urgency: false,
    needs_response: true,
    manual_action_required: true,
  };
  db.ConversationAutomationState.findOne = async () => state;
  db.Message.findAll = async () => [
    {
      id: 107291,
      direction: 'inbound',
      content: 'Vale',
      message_type: 'text',
      metadata: {},
    },
    {
      id: 107279,
      direction: 'inbound',
      content: '¿Me dices la dirección?',
      message_type: 'text',
      metadata: {},
    },
  ];
  const message = {
    id: 107291,
    conversation_id: 9582,
    direction: 'inbound',
    message_type: 'text',
    content: 'Vale',
    metadata: {},
  };
  let completions = 0;
  const lowConfidence = await reconcilePendingAutomationAttentionForInboundMessage({
    conversation: { id: 9582, clinic_id: 19 },
    message,
    classifier: async () => ({
      decision: 'resolved_by_patient',
      confidence: RESOLUTION_CONFIDENCE - 0.01,
      reason: 'No es inequívoco.',
    }),
    stateCompleter: async () => {
      completions += 1;
      return {};
    },
  });
  assert.equal(lowConfidence.resolved, false);

  state.possible_urgency = true;
  const urgent = await reconcilePendingAutomationAttentionForInboundMessage({
    conversation: { id: 9582, clinic_id: 19 },
    message,
    classifier: async () => {
      throw new Error('urgent_state_must_not_be_classified');
    },
    stateCompleter: async () => {
      completions += 1;
      return {};
    },
  });
  assert.equal(urgent.resolved, false);
  assert.equal(urgent.reason, 'state_not_reconcilable');
  assert.equal(completions, 0);
});

test('no reconcilia por IA una acción de agenda que sigue pendiente', async (t) => {
  const originalStateFindOne = db.ConversationAutomationState.findOne;
  t.after(() => {
    db.ConversationAutomationState.findOne = originalStateFindOne;
  });
  db.ConversationAutomationState.findOne = async () => ({
    clinic_id: 66,
    conversation_id: 9002,
    stage: 'review',
    status: 'review',
    source_message_id: 1200,
    execution_id: 3300,
    appointment_id: 4400,
    appointment_status: 'cambio_solicitado',
    intent: 'otra',
    possible_urgency: false,
    needs_response: false,
    manual_action_required: true,
  });

  const result = await reconcilePendingAutomationAttentionForInboundMessage({
    conversation: { id: 9002, clinic_id: 66 },
    message: {
      id: 1201,
      conversation_id: 9002,
      direction: 'inbound',
      message_type: 'text',
      content: 'Déjala como estaba',
      metadata: {},
    },
    classifier: async () => {
      throw new Error('pending_appointment_action_must_not_be_classified');
    },
  });

  assert.deepEqual(result, {
    resolved: false,
    reason: 'appointment_action_still_required',
  });
});

test('absorbe un seguimiento tardío que continúa una revisión de conversación sin relanzar el flujo', async (t) => {
  const originals = {
    stateFindOne: db.ConversationAutomationState.findOne,
    messageFindAll: db.Message.findAll,
    executionFindByPk: db.FlowExecutionV2.findByPk,
  };
  t.after(() => {
    db.ConversationAutomationState.findOne = originals.stateFindOne;
    db.Message.findAll = originals.messageFindAll;
    db.FlowExecutionV2.findByPk = originals.executionFindByPk;
  });

  db.ConversationAutomationState.findOne = async () => ({
    clinic_id: 66,
    conversation_id: 9698,
    stage: 'review',
    status: 'review',
    source_message_id: 107415,
    execution_id: 2331,
    appointment_id: null,
    appointment_status: null,
    intent: 'otra',
    possible_urgency: false,
    needs_response: true,
    manual_action_required: true,
  });
  db.Message.findAll = async () => [
    {
      id: 107417,
      direction: 'inbound',
      content: 'Ok',
      message_type: 'text',
      metadata: {},
    },
    {
      id: 107416,
      direction: 'outbound',
      content: 'Te contestaremos cuanto antes.',
      message_type: 'text',
      metadata: {},
    },
    {
      id: 107415,
      direction: 'inbound',
      content: '',
      message_type: 'image',
      metadata: { media: { kind: 'unsupported' } },
    },
  ];
  db.FlowExecutionV2.findByPk = async (id, options) => {
    assert.equal(id, 2331);
    assert.deepEqual(options.attributes, ['id', 'trigger_type', 'trigger_entity_type']);
    return { id, trigger_type: 'message_received', trigger_entity_type: 'conversation' };
  };

  const updates = [];
  const result = await reconcilePendingAutomationAttentionForInboundMessage({
    conversation: { id: 9698, clinic_id: 66 },
    message: {
      id: 107417,
      conversation_id: 9698,
      direction: 'inbound',
      message_type: 'text',
      content: 'Ok',
      metadata: {},
      update: async (patch) => updates.push(patch),
    },
    classifier: async () => ({
      decision: 'continues_pending',
      confidence: 0.98,
      reason: 'El acuse continúa el asunto ya pendiente.',
    }),
  });

  assert.equal(result.handled, true);
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'patient_followup_continues_pending');
  assert.equal(result.execution_id, 2331);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].metadata.automation_attention_reconciliation.decision, 'continues_pending');
  assert.equal(updates[0].metadata.automation_attention_reconciliation.applied, true);
});

test('deja pasar una acción nueva de cita para que la evalúe la automatización normal', async (t) => {
  const originalStateFindOne = db.ConversationAutomationState.findOne;
  const originalMessageFindAll = db.Message.findAll;
  t.after(() => {
    db.ConversationAutomationState.findOne = originalStateFindOne;
    db.Message.findAll = originalMessageFindAll;
  });
  db.ConversationAutomationState.findOne = async () => ({
    clinic_id: 66,
    conversation_id: 9698,
    stage: 'review',
    status: 'review',
    source_message_id: 107415,
    execution_id: 2331,
    appointment_id: null,
    intent: 'otra',
    possible_urgency: false,
    needs_response: true,
    manual_action_required: true,
  });
  db.Message.findAll = async () => [
    { id: 107415, direction: 'inbound', content: 'Tengo una duda', message_type: 'text', metadata: {} },
    { id: 107417, direction: 'inbound', content: 'Cancela mi cita de mañana', message_type: 'text', metadata: {} },
  ];

  const result = await reconcilePendingAutomationAttentionForInboundMessage({
    conversation: { id: 9698, clinic_id: 66 },
    message: {
      id: 107417,
      conversation_id: 9698,
      direction: 'inbound',
      message_type: 'text',
      content: 'Cancela mi cita de mañana',
      metadata: {},
    },
    classifier: async () => ({
      decision: 'new_automation_required',
      confidence: 0.99,
      reason: 'Solicita una acción nueva sobre la cita.',
    }),
  });

  assert.equal(result.handled, undefined);
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'new_automation_required');
});

test('un retry reutiliza la conciliación aplicada sin repetir IA ni efectos', async (t) => {
  const originalStateFindOne = db.ConversationAutomationState.findOne;
  t.after(() => {
    db.ConversationAutomationState.findOne = originalStateFindOne;
  });
  db.ConversationAutomationState.findOne = async () => {
    throw new Error('idempotent_retry_must_not_reload_state');
  };
  let notificationCalls = 0;

  const result = await reconcilePendingAutomationAttentionForInboundMessage({
    conversation: { id: 9582, clinic_id: 19 },
    message: {
      id: 107291,
      conversation_id: 9582,
      direction: 'inbound',
      message_type: 'text',
      content: 'Ya tengo la dirección, muchas gracias',
      metadata: {
        automation_attention_reconciliation: {
          decision: 'resolved_by_patient',
          confidence: 0.95,
          reason: 'Ya está resuelto.',
          execution_id: 2320,
          applied: true,
        },
      },
    },
    classifier: async () => {
      throw new Error('idempotent_retry_must_not_classify');
    },
    notificationResolver: async () => {
      notificationCalls += 1;
      return { success: true, updated: 0 };
    },
  });

  assert.equal(result.resolved, true);
  assert.equal(result.idempotent, true);
  assert.equal(result.execution_id, 2320);
  assert.equal(notificationCalls, 1);
});
