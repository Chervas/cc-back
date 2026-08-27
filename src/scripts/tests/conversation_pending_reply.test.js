'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const db = require('../../../models');
const {
  getPendingReplyStatesByConversationIds,
  normalizeConversationIds,
  resolveAutomationAttentionForConversation,
} = require('../../services/conversationPendingReply.service');

test('normaliza conversaciones y combina pendientes con atención de automatización', async (t) => {
  const originalQuery = db.sequelize.query;
  let queryIndex = 0;

  t.after(() => {
    db.sequelize.query = originalQuery;
  });

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
    assert.match(sql, /automation\.system_notification/);
    assert.match(sql, /user_id = :userId/);
    assert.match(sql, /quickChatResponseMessageId/);
    assert.match(sql, /FlowExecutionsV2 execution/);
    assert.match(sql, /last_response_context\.response_message_id/);
    return [{ conversation_id: 8, attention_count: 2, response_message_id: 913 }];
  };

  assert.deepEqual(normalizeConversationIds([7, '8', 7, 0, null, 'x']), [7, 8]);
  const states = await getPendingReplyStatesByConversationIds([7, '8', 7], { userId: 44 });

  assert.deepEqual(states.get(7), {
    count: 2,
    unreadCount: 1,
    requiresAutomationAttention: false,
    automationAttentionCount: 0,
    automationAttentionMessageId: null,
  });
  assert.deepEqual(states.get(8), {
    count: 0,
    unreadCount: 0,
    requiresAutomationAttention: true,
    automationAttentionCount: 2,
    automationAttentionMessageId: 913,
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
});

test('la resolución manual solo cierra avisos del usuario y conversación indicados', async (t) => {
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
    assert.equal(where.event, 'automation.system_notification');
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
    assert.equal(where.event, 'automation.system_notification');
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

test('el envío manual y el eco móvil resuelven la atención sin alterar los automatismos', () => {
  const controller = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/conversation.controller.js'),
    'utf8',
  );
  const workers = fs.readFileSync(
    path.resolve(__dirname, '../../workers/queue.workers.js'),
    'utf8',
  );

  assert.match(controller, /reason:\s*'manual_reply_sent'/);
  assert.match(controller, /pending_automation_message_id:\s*null/);
  assert.match(workers, /sourceEvent === 'smb_message_echoes'/);
  assert.match(workers, /reason:\s*'mobile_reply_sent'/);
});
