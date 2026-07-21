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
    if (queryIndex === 1) {
      assert.match(sql, /direction = 'outbound'/);
      assert.match(sql, /status <> 'failed'/);
      assert.match(sql, /inbound\.id > COALESCE/);
      return [
        { conversation_id: 7, pending_count: 2 },
        { conversation_id: 8, pending_count: 0 },
      ];
    }
    assert.match(sql, /automation\.system_notification/);
    return [{ conversation_id: 8 }];
  };

  assert.deepEqual(normalizeConversationIds([7, '8', 7, 0, null, 'x']), [7, 8]);
  const states = await getPendingReplyStatesByConversationIds([7, '8', 7]);

  assert.deepEqual(states.get(7), { count: 2, requiresAutomationAttention: false });
  assert.deepEqual(states.get(8), { count: 0, requiresAutomationAttention: true });
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

test('abrir una conversación no recalcula el pendiente ni el agregado global', () => {
  const controller = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/conversation.controller.js'),
    'utf8',
  );
  const start = controller.indexOf('exports.markAsRead = async');
  const end = controller.indexOf('\nexports.postMessage', start);
  assert.ok(start >= 0 && end > start, 'markAsRead debe existir');
  const block = controller.slice(start, end);

  assert.match(block, /ConversationRead\.upsert/);
  assert.doesNotMatch(block, /getPendingReplyStatesByConversationIds|getTotalUnreadCountForUser|unread:updated/);
});
