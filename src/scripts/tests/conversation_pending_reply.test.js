'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const db = require('../../../models');
const {
  completeAutomationStateAfterHumanReplyForConversation,
  findHumanReplyAfterMessage,
  getPendingReplyStatesByConversationIds,
  normalizeConversationIds,
  resolveAutomationAttentionForConversation,
} = require('../../services/conversationPendingReply.service');
const {
  markBufferedResponseExecutionsForHumanReply,
} = require('../../services/automationHumanIntervention.service');
const conversationAutomationState = require('../../services/conversationAutomationState.service');

test('detecta una respuesta humana posterior aunque la IA termine después', async (t) => {
  const originalQuery = db.sequelize.query;
  t.after(() => {
    db.sequelize.query = originalQuery;
  });

  db.sequelize.query = async (sql, options) => {
    assert.match(sql, /id > :responseMessageId/);
    assert.match(sql, /sender_id IS NOT NULL/);
    assert.match(sql, /smb_message_echoes/);
    assert.deepEqual(options.replacements, {
      conversationId: 8629,
      responseMessageId: 91002,
    });
    return [{ id: 91007 }];
  };

  assert.deepEqual(await findHumanReplyAfterMessage(8629, 91002), { id: 91007 });
});

test('no inventa una respuesta humana cuando no hay mensajes posteriores', async (t) => {
  const originalQuery = db.sequelize.query;
  t.after(() => {
    db.sequelize.query = originalQuery;
  });
  db.sequelize.query = async () => [];

  assert.equal(await findHumanReplyAfterMessage(8629, 91002), null);
  assert.equal(await findHumanReplyAfterMessage(null, 91002), null);
});

test('una respuesta humana marca solo la ejecución que ya acumula respuesta del paciente', async (t) => {
  const originals = {
    findAll: db.FlowExecutionV2.findAll,
    update: db.FlowExecutionV2.update,
    completeState: conversationAutomationState.completeState,
  };
  t.after(() => {
    db.FlowExecutionV2.findAll = originals.findAll;
    db.FlowExecutionV2.update = originals.update;
    conversationAutomationState.completeState = originals.completeState;
  });

  db.FlowExecutionV2.findAll = async () => [
    {
      id: 81,
      current_node_id: 'N3',
      waiting_meta: {
        type: 'delay/wait_response',
        inbound_conversation_id: 15,
        last_inbound_message_id: 91002,
        pending_response_message_ids: [91002],
      },
      context: { conversation: { id: 15 } },
    },
    {
      id: 82,
      current_node_id: 'N3',
      waiting_meta: { type: 'delay/wait_response', inbound_conversation_id: 15 },
      context: { conversation: { id: 15 } },
    },
  ];
  const updated = [];
  db.FlowExecutionV2.update = async (patch, options) => {
    updated.push({ patch, where: options.where });
    return [1];
  };
  const completedStates = [];
  conversationAutomationState.completeState = async (params, options) => {
    completedStates.push({ params, options });
    return params;
  };

  const result = await markBufferedResponseExecutionsForHumanReply({
    clinicId: 66,
    conversationId: 15,
    humanMessageId: 91007,
  });

  assert.deepEqual(result, { marked: 1, execution_ids: [81] });
  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0].where, { id: 81, status: 'waiting' });
  assert.equal(updated[0].patch.waiting_meta.human_takeover, true);
  assert.equal(updated[0].patch.waiting_meta.human_message_id, 91007);
  assert.deepEqual(completedStates, [{
    params: { clinicId: 66, conversationId: 15, sourceMessageId: 91002 },
    options: { expectedExecutionId: 81 },
  }]);
});

test('normaliza conversaciones y combina pendientes con atención de automatización', async (t) => {
  const originalQuery = db.sequelize.query;
  const originalAutomationStateFindAll = db.ConversationAutomationState.findAll;
  let queryIndex = 0;

  t.after(() => {
    db.sequelize.query = originalQuery;
    db.ConversationAutomationState.findAll = originalAutomationStateFindAll;
  });

  db.ConversationAutomationState.findAll = async () => [{
    conversation_id: 7,
    source_message_id: 912,
    stage: 'collecting',
    status: 'active',
  }];

  db.sequelize.query = async (sql, options) => {
    queryIndex += 1;
    assert.deepEqual(options.replacements.conversationIds, [7, 8]);
    assert.equal(options.replacements.userId, 44);
    if (queryIndex === 1) {
      assert.match(sql, /direction = 'outbound'/);
      assert.match(sql, /status <> 'failed'/);
      assert.match(sql, /inbound\.id > COALESCE/);
      assert.match(sql, /ConversationReads conversation_read/);
      assert.match(sql, /inbound\.createdAt > conversation_read\.last_read_at/);
      return [
        { conversation_id: 7, pending_count: 2, unread_count: 1 },
        { conversation_id: 8, pending_count: 0, unread_count: 0 },
      ];
    }
    if (queryIndex === 2) {
      assert.match(sql, /automation\.system_notification/);
      assert.match(sql, /automation\.persistent_alert/);
      assert.match(sql, /user_id = :userId/);
      assert.match(sql, /quickChatResponseMessageId/);
      assert.match(sql, /FlowExecutionsV2 execution/);
      assert.match(sql, /last_response_context\.response_message_id/);
      return [{ conversation_id: 8, attention_count: 2, response_message_id: 913 }];
    }
    throw new Error('unexpected_legacy_runtime_query');
  };

  assert.deepEqual(normalizeConversationIds([7, '8', 7, 0, null, 'x']), [7, 8]);
  const states = await getPendingReplyStatesByConversationIds([7, '8', 7], { userId: 44 });

  assert.deepEqual(states.get(7), {
    count: 2,
    unreadCount: 1,
    requiresAutomationAttention: false,
    automationAttentionCount: 0,
    automationAttentionMessageId: null,
    isAutomationResponseProcessing: true,
    automationResponseProcessingMessageId: 912,
    automationProcessingStage: 'collecting',
    automationProcessingStatus: 'active',
    automationProcessingStartedAt: null,
    automationProcessingDeadlineAt: null,
    automationActionAppointmentId: null,
    automationActionAppointmentStatus: null,
    automationIntent: null,
    automationPossibleUrgency: false,
    automationNeedsResponse: false,
    automationManualActionRequired: false,
  });
  assert.deepEqual(states.get(8), {
    count: 0,
    unreadCount: 0,
    requiresAutomationAttention: true,
    automationAttentionCount: 2,
    automationAttentionMessageId: 913,
    isAutomationResponseProcessing: false,
    automationResponseProcessingMessageId: null,
    automationProcessingStage: null,
    automationProcessingStatus: null,
    automationProcessingStartedAt: null,
    automationProcessingDeadlineAt: null,
    automationActionAppointmentId: null,
    automationActionAppointmentStatus: null,
    automationIntent: null,
    automationPossibleUrgency: false,
    automationNeedsResponse: false,
    automationManualActionRequired: false,
  });
  assert.equal(queryIndex, 2);
});

test('un conjunto vacío no consulta la base de datos', async (t) => {
  const originalQuery = db.sequelize.query;
  t.after(() => {
    db.sequelize.query = originalQuery;
  });
  db.sequelize.query = async () => {
    throw new Error('unexpected_query');
  };

  const states = await getPendingReplyStatesByConversationIds([]);
  assert.equal(states.size, 0);
});

test('abrir una conversación actualiza solo la lectura del usuario', () => {
  const controller = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/conversation.controller.js'),
    'utf8',
  );
  const start = controller.indexOf('exports.markAsRead = async');
  const end = controller.indexOf('\nexports.postMessage', start);
  assert.ok(start >= 0 && end > start, 'markAsRead debe existir');
  const block = controller.slice(start, end);

  assert.match(block, /ConversationRead\.upsert/);
  assert.match(block, /user:\$\{userId\}.*conversation:read/s);
  assert.doesNotMatch(block, /getPendingReplyStatesByConversationIds|unread:updated/);
  assert.match(controller, /pending_automation_count = pendingState\?\.requiresAutomationAttention === true\s*\? Math\.max\(1, Number\(pendingState\?\.automationAttentionCount \|\| 0\)\)/);
  assert.match(controller, /exports\.resolveAutomationAttention = async/);
  assert.match(controller, /allUsers:\s*true/);
  assert.match(controller, /completeManualAutomationStateForConversation\(conversationId\)/);
});

test('la resolución del servicio puede cerrar avisos del usuario y conversación indicados', async (t) => {
  const originalFindAll = db.Notification.findAll;
  const updated = [];
  const fakeNotification = {
    get: (key) => {
      if (key === 'data') return { quickChatConversationId: 15 };
      if (key && typeof key === 'object') return { userId: 44, data: { quickChatConversationId: 15 } };
      return undefined;
    },
    update: async (payload) => {
      updated.push(payload);
      return fakeNotification;
    },
  };
  t.after(() => {
    db.Notification.findAll = originalFindAll;
  });
  db.Notification.findAll = async ({ where }) => {
    assert.equal(where.userId, 44);
    assert.deepEqual(where.event[db.Sequelize.Op.in], [
      'automation.system_notification',
      'automation.persistent_alert',
    ]);
    assert.equal(where.isRead, false);
    return [fakeNotification];
  };

  const result = await resolveAutomationAttentionForConversation(15, 44);
  assert.deepEqual(result, { success: true, updated: 1 });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].isRead, true);
  assert.equal(updated[0].data.manual_resolution_reason, 'operator_action_completed');
  assert.equal(updated[0].data.manual_resolved_by_user_id, 44);
});

test('una respuesta manual cierra el aviso para todos los usuarios de la conversación', async (t) => {
  const originalFindAll = db.Notification.findAll;
  const updated = [];
  const fakeNotification = {
    get: (key) => {
      if (key === 'data') return { quickChatConversationId: 15, quickChatResponseMessageId: 913 };
      if (key && typeof key === 'object') {
        return { userId: 44, data: { quickChatConversationId: 15, quickChatResponseMessageId: 913 } };
      }
      return undefined;
    },
    update: async (payload) => {
      updated.push(payload);
      return fakeNotification;
    },
  };
  t.after(() => {
    db.Notification.findAll = originalFindAll;
  });
  db.Notification.findAll = async ({ where }) => {
    assert.equal(where.userId, undefined);
    assert.deepEqual(where.event[db.Sequelize.Op.in], [
      'automation.system_notification',
      'automation.persistent_alert',
    ]);
    assert.equal(where.isRead, false);
    return [fakeNotification];
  };

  const result = await resolveAutomationAttentionForConversation(15, null, {
    allUsers: true,
    reason: 'manual_reply_sent',
  });
  assert.deepEqual(result, { success: true, updated: 1 });
  assert.equal(updated[0].isRead, true);
  assert.equal(updated[0].data.manual_resolution_reason, 'manual_reply_sent');
  assert.equal(updated[0].data.manual_resolved_by_user_id, null);
});

test('una respuesta humana completa la revisión de un flujo puramente conversacional', async (t) => {
  const originals = {
    stateFindOne: db.ConversationAutomationState.findOne,
    executionFindByPk: db.FlowExecutionV2.findByPk,
    completeState: conversationAutomationState.completeState,
  };
  t.after(() => {
    db.ConversationAutomationState.findOne = originals.stateFindOne;
    db.FlowExecutionV2.findByPk = originals.executionFindByPk;
    conversationAutomationState.completeState = originals.completeState;
  });

  db.ConversationAutomationState.findOne = async () => ({
    clinic_id: 66,
    conversation_id: 9616,
    stage: 'review',
    status: 'review',
    execution_id: 2291,
    appointment_id: null,
    possible_urgency: false,
    manual_action_required: true,
  });
  db.FlowExecutionV2.findByPk = async (id) => {
    assert.equal(id, 2291);
    return {
      id,
      trigger_type: 'message_received',
      trigger_entity_type: 'conversation',
    };
  };
  const completed = [];
  conversationAutomationState.completeState = async (params, options) => {
    completed.push({ params, options });
    return params;
  };

  const result = await completeAutomationStateAfterHumanReplyForConversation(9616);

  assert.deepEqual(result, { completed: true, reason: null });
  assert.deepEqual(completed, [{
    params: { clinicId: 66, conversationId: 9616 },
    options: { expectedExecutionId: 2291 },
  }]);
});

test('una respuesta escrita no completa una gestión de cita sin resolver', async (t) => {
  const originals = {
    stateFindOne: db.ConversationAutomationState.findOne,
    executionFindByPk: db.FlowExecutionV2.findByPk,
    completeState: conversationAutomationState.completeState,
  };
  t.after(() => {
    db.ConversationAutomationState.findOne = originals.stateFindOne;
    db.FlowExecutionV2.findByPk = originals.executionFindByPk;
    conversationAutomationState.completeState = originals.completeState;
  });

  db.ConversationAutomationState.findOne = async () => ({
    clinic_id: 66,
    conversation_id: 9001,
    stage: 'review',
    status: 'review',
    execution_id: 3001,
    appointment_id: null,
    possible_urgency: false,
    manual_action_required: true,
  });
  db.FlowExecutionV2.findByPk = async () => ({
    id: 3001,
    trigger_type: 'appointment_updated',
    trigger_entity_type: 'appointment',
  });
  conversationAutomationState.completeState = async () => {
    throw new Error('appointment_state_must_not_complete');
  };

  const result = await completeAutomationStateAfterHumanReplyForConversation(9001);

  assert.deepEqual(result, { completed: false, reason: 'operator_action_still_required' });
});

test('el envío manual y el eco móvil detienen el análisis pendiente y resuelven la atención', () => {
  const controller = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/conversation.controller.js'),
    'utf8',
  );
  const workers = fs.readFileSync(
    path.resolve(__dirname, '../../workers/queue.workers.js'),
    'utf8',
  );

  assert.match(controller, /reason:\s*'manual_reply_sent'/);
  assert.match(controller, /manual_reply_sent_during_response_buffer/);
  assert.match(controller, /pending_automation_message_id:\s*null/);
  assert.match(workers, /sourceEvent === 'smb_message_echoes'/);
  assert.match(workers, /mobile_reply_sent_during_response_buffer/);
  assert.match(workers, /reason:\s*'mobile_reply_sent'/);
  assert.match(controller, /completeAutomationStateAfterHumanReplyForConversation/);
  assert.match(workers, /completeAutomationStateAfterHumanReplyForConversation/);
});

test('el flujo evita crear un aviso tardío si el operador ya respondió', () => {
  const flowEngine = fs.readFileSync(
    path.resolve(__dirname, '../../services/flowEngineV2.service.js'),
    'utf8',
  );
  assert.match(flowEngine, /findHumanReplyAfterMessage\(quickChatConversationId, quickChatResponseMessageId\)/);
  assert.match(flowEngine, /status:\s*'resolved_before_notification'/);
  assert.match(flowEngine, /notifications_created:\s*0/);
});
