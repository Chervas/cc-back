'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

test('reaction evidence uses exact provider targets and conversation scope in real MySQL', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 120000,
}, async () => withIsolatedCampaignMysql(async ({ sql, report }) => {
  const Message = sql.define('Message', {
    id: { type: DataTypes.INTEGER, primaryKey: true }, conversation_id: DataTypes.INTEGER,
    direction: DataTypes.STRING, message_type: DataTypes.STRING, status: DataTypes.STRING,
    content: DataTypes.TEXT, metadata: DataTypes.JSON, sent_at: DataTypes.DATE,
  }, { timestamps: true });
  await Message.sync();
  const before = new Date('2026-10-05T15:38:00Z'), after = new Date('2026-10-05T15:43:00Z');
  await Message.bulkCreate([
    { id: 1, conversation_id: 10, direction: 'outbound', message_type: 'text', status: 'read',
      content: 'Confirma los datos de tu cita.', metadata: { wamid: 'wamid.exact' }, sent_at: before },
    { id: 2, conversation_id: 99, direction: 'outbound', message_type: 'text', status: 'read',
      content: 'Otra clinica', metadata: { wamid: 'wamid.exact' }, sent_at: before },
    { id: 3, conversation_id: 10, direction: 'outbound', message_type: 'text', status: 'read',
      content: 'Gracias', metadata: { wamid: 'wamid.unrelated' }, sent_at: before },
    { id: 4, conversation_id: 10, direction: 'inbound', message_type: 'reaction',
      metadata: { reaction: { emoji: '\u{1f44d}', target_message_id: 'wamid.exact' } }, sent_at: after },
    { id: 5, conversation_id: 10, direction: 'inbound', message_type: 'reaction',
      metadata: { reaction: { emoji: '\u{1f44d}', target_message_id: 'wamid.missing' } }, sent_at: after },
  ]);
  const { hydrateResponseReactionTargets } = require('../../lib/automation-conversation-context');
  const context = id => ({ response_message_id: id, response_items: [{ message_id: id,
    content_type: 'reaction', emoji: 'FORGED', target_message_id: 'FORGED', target_message_preview: 'FORGED' }] });
  const load = (id, conversationId = 10) => hydrateResponseReactionTargets({
    Message, conversationId, responseContext: context(id),
  });
  const valid = await load(4);
  assert.equal(valid.response_items[0].target_message_preview, 'Confirma los datos de tu cita.');
  assert.equal(valid.response_items[0].target_message_id, 'wamid.exact');
  assert.equal(valid.response_items[0].emoji, '\u{1f44d}');
  assert.equal((await load(4, 99)).response_items[0].target_message_preview, null);
  assert.equal((await load(5)).response_items[0].target_message_preview, null);
  await Message.update({ metadata: { reaction: { emoji: '\u{1f44d}', message_id: 'wamid.exact',
    target_message_id: 1, target_message_preview: 'FORGED' } } }, { where: { id: 4 } });
  assert.equal((await load(4)).response_items[0].target_message_preview, 'Confirma los datos de tu cita.');
  await Message.update({ metadata: { wamid: 'wamid.exact', revoked_at: after.toISOString() } }, { where: { id: 1 } });
  assert.equal((await load(4)).response_items[0].target_message_preview, null);
  await Message.update({ metadata: { wamid: 'wamid.exact' } }, { where: { id: 1 } });
  await Message.create({ id: 6, conversation_id: 10, direction: 'outbound', message_type: 'text', status: 'read',
    content: 'Duplicado', metadata: { wamid: 'wamid.exact' }, sent_at: before });
  assert.equal((await load(4)).response_items[0].target_message_preview, null);
  assert.equal(await Message.count(), 6);
  report.checks.push('exact_json_target', 'conversation_scope', 'missing_target', 'revocation', 'ambiguous_target', 'no_message_writes');
}));
