'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataTypes: D, Sequelize } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { bulkOutboundSql, quickChatActivitySql, isBulkOutbound, parseChangedConversationIds } = require('../../lib/quickchat-bulk-visibility');

test('classifies outgoing mass messages and review requests without suppressing their incoming replies', () => {
  assert.equal(isBulkOutbound({ direction: 'outbound', metadata: { source: 'marketing_bulk_sends' } }), true);
  assert.equal(isBulkOutbound({ direction: 'outbound', metadata: { communication_purpose: 'review_request' } }), true);
  assert.equal(isBulkOutbound({ direction: 'inbound', metadata: { communication_purpose: 'review_request' } }), false);
  assert.equal(isBulkOutbound({ direction: 'outbound' }), false);
});

test('socket batches accept at most 50 distinct positive integer inputs and never widen malformed reads', () => {
  assert.equal(parseChangedConversationIds(undefined), undefined);
  for (const value of ['', null, [], '0', 'a', '1,,2', '1e5', '9007199254740992', Array(51).fill('1').join(',')]) {
    assert.equal(parseChangedConversationIds(value), null);
  }
  assert.deepEqual(parseChangedConversationIds('1,67,1'), [1,67]);
});

test('QuickChat filters and sorts before pagination while preserving direct searches and clinic-scoped replies', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1',
}, async () => withIsolatedCampaignMysql(async ({ sql }) => {
  const Conversation = sql.define('Conversation', {
    clinic_id: D.INTEGER, channel: D.STRING, last_message_at: D.DATE,
  });
  const Message = sql.define('Message', {
    conversation_id: D.INTEGER, direction: D.STRING, message_type: D.STRING, sent_at: D.DATE, metadata: D.JSON,
  }, { indexes: [{ fields: ['conversation_id', 'direction', 'createdAt'] }] });
  const Link = sql.define('WhatsappConversationLink', {
    clinic_id: D.INTEGER, canonical_id: D.INTEGER, conversation_id: D.INTEGER,
  }, { indexes: [{ fields: ['canonical_id', 'clinic_id'] }] });
  Conversation.hasMany(Message, { as: 'messages', foreignKey: 'conversation_id' });
  await sql.sync();
  const old = new Date('2026-11-25T09:00:00Z'), bulkAt = new Date('2026-11-25T10:00:00Z');
  const replyAt = new Date('2026-11-25T11:00:00Z');
  const bulk = { direction: 'outbound', message_type: 'template', sent_at: bulkAt,
    metadata: { source: 'marketing_bulk_sends' } };
  const incoming = { direction: 'inbound', message_type: 'text', sent_at: replyAt };
  await Conversation.bulkCreate(Array.from({ length: 1003 }, (_, i) => ({
    id: i + 1, clinic_id: 56, channel: 'whatsapp', last_message_at: bulkAt,
  })));
  await Message.bulkCreate(Array.from({ length: 1000 }, (_, i) => ({ conversation_id: i + 1, ...bulk })));
  await Message.bulkCreate(Array.from({ length: 30 }, (_, i) => ({ conversation_id: i + 1, ...incoming })));
  await Message.bulkCreate([
    { conversation_id: 1001, ...bulk },
    { conversation_id: 1001, direction: 'outbound', message_type: 'text', sent_at: old },
    { conversation_id: 1002, ...bulk },
    { conversation_id: 1002, direction: 'outbound', message_type: 'event', sent_at: replyAt },
    { conversation_id: 1003, ...incoming },
    ...Array.from({ length: 8 }, () => ({ conversation_id: 1001, ...bulk })),
  ]);
  await Link.bulkCreate([{ clinic_id: 56, canonical_id: 1002, conversation_id: 1003 }]);
  const makeQuery = linkedHistory => ({
    where: { clinic_id: 56 },
    attributes: { include: [[Sequelize.literal(quickChatActivitySql({ linkedHistory })), 'quickchat_activity_at']] },
    having: Sequelize.literal('`quickchat_activity_at` IS NOT NULL'),
    order: [[Sequelize.literal('`quickchat_activity_at`'), 'DESC'], ['id', 'ASC']],
    subQuery: false, raw: true,
  });
  const first = await Conversation.findAll({ ...makeQuery(false), limit: 20 });
  const next = await Conversation.findAll({ ...makeQuery(false), limit: 20, offset: 20 });
  assert.equal(first.length, 20);
  assert.deepEqual(next.map(row => row.id), [21,22,23,24,25,26,27,28,29,30,1003,1001]);
  assert.equal(new Date(next.at(-1).quickchat_activity_at).toISOString(), old.toISOString());
  const withPreviews = await Conversation.findAll({ ...makeQuery(true), raw: false,
    where: { id: [1, 1001], clinic_id: 56 },
    include: [{ model: Message, as: 'messages', separate: true, limit: 6,
      where: Sequelize.literal(`NOT ${bulkOutboundSql('Message')}`) }],
  });
  assert.deepEqual(withPreviews.map(row => row.messages.map(message => message.direction)), [['inbound'], ['outbound']]);
  assert.ok(await Conversation.findOne({ where: { id: 99, clinic_id: 56 } }), 'a direct search can reach an unanswered campaign');
  const [canonical] = await Conversation.findAll({ ...makeQuery(true), where: { id: 1002, clinic_id: 56 } });
  assert.equal(new Date(canonical.quickchat_activity_at).toISOString(), replyAt.toISOString());
  const identity = require('../../services/whatsappContactIdentity.service');
  const resolve = (ids, clinics) => identity.canonicalListIds(ids, clinics,
    async (query, values) => (await sql.query(query, { replacements: values }))[0]);
  assert.deepEqual(await resolve([1003, 1002], [56]), [1002]);
  assert.deepEqual(await resolve([1003], [57]), []);
  const changed = () => Conversation.findAll({ ...makeQuery(true), where: { clinic_id: 56, id: [99, 100] } });
  assert.deepEqual(await changed(), [], 'no bulk-only rows are transmitted');
  await Message.create({ ...incoming, conversation_id: 99 });
  assert.deepEqual((await changed()).map(row => row.id), [99], 'a reply admits only its conversation');
  await Link.update({ clinic_id: 57 }, { where: { canonical_id: 1002 } });
  assert.equal((await Conversation.findAll({ ...makeQuery(true), where: { id: 1002, clinic_id: 56 } })).length, 0);
}));
