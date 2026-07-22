'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const db = require('../../../models');
const {
  getPendingReplyStatesByConversationIds,
  normalizeConversationIds,
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
    return [{ conversation_id: 8 }];
  };

  assert.deepEqual(normalizeConversationIds([7, '8', 7, 0, null, 'x']), [7, 8]);
  const states = await getPendingReplyStatesByConversationIds([7, '8', 7], { userId: 44 });

  assert.deepEqual(states.get(7), { count: 2, unreadCount: 1, requiresAutomationAttention: false });
  assert.deepEqual(states.get(8), { count: 0, unreadCount: 0, requiresAutomationAttention: true });
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
  assert.match(controller, /pending_automation_count = pendingState\?\.requiresAutomationAttention === true\s*\? \(pendingState\?\.unreadCount \?\? 0\)/);
  assert.doesNotMatch(controller, /pending_automation_count = pendingState\?\.requiresAutomationAttention === true\s*\? \(pendingState\?\.count \?\? 0\)/);
});
