'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { appointmentConversationUnreadCounts } = require('../../lib/appointment-conversation-unread');

test('actual owned MySQL unread SQL separates personal read receipts, clinic/channel and pending reply without touching source data',
  { skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 120000 }, async () => {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    await sql.query('CREATE TABLE Conversations (id INT PRIMARY KEY, clinic_id INT NOT NULL, channel VARCHAR(20) NOT NULL)');
    await sql.query('CREATE TABLE ConversationReads (conversation_id INT NOT NULL, user_id INT NOT NULL, last_read_at DATETIME(3) NOT NULL, PRIMARY KEY(conversation_id,user_id))');
    await sql.query('CREATE TABLE Messages (id INT PRIMARY KEY, conversation_id INT NOT NULL, direction VARCHAR(20) NOT NULL, message_type VARCHAR(20), metadata JSON, createdAt DATETIME(3) NOT NULL)');
    await sql.query("INSERT INTO Conversations VALUES (10,72,'whatsapp'),(11,73,'whatsapp'),(12,72,'email')");
    await sql.query("INSERT INTO ConversationReads VALUES (10,7,'2030-01-07 10:03:00.000'),(10,8,'2030-01-07 10:01:00.000')");
    await sql.query(`INSERT INTO Messages VALUES
      (1,10,'inbound','text',JSON_OBJECT(),'2030-01-07 10:01:00.000'),
      (2,10,'inbound','text',JSON_OBJECT(),'2030-01-07 10:02:00.000'),
      (3,10,'inbound','text',JSON_OBJECT(),'2030-01-07 10:03:00.000'),
      (4,10,'inbound','event',JSON_OBJECT(),'2030-01-07 10:04:00.000'),
      (5,10,'inbound','text',JSON_OBJECT('hide_from_quickchat',true),'2030-01-07 10:04:00.000'),
      (6,10,'inbound','text',JSON_OBJECT('qa_cleanup',true),'2030-01-07 10:04:00.000'),
      (7,10,'outbound','text',JSON_OBJECT(),'2030-01-07 10:05:00.000'),
      (8,11,'inbound','text',JSON_OBJECT(),'2030-01-07 10:06:00.000'),
      (9,12,'inbound','text',JSON_OBJECT(),'2030-01-07 10:06:00.000')`);
    const db = { sequelize: sql, Sequelize };
    const count = (userId, conversationIds = [10,11,12], clinicIds = [72]) => appointmentConversationUnreadCounts({ db, userId, conversationIds, clinicIds });
    const [[beforeMessages]] = await sql.query('SELECT COUNT(*) AS count FROM Messages');
    const [[beforeReads]] = await sql.query('SELECT COUNT(*) AS count FROM ConversationReads');
    const read = await count(7), another = await count(8), absent = await count(9);
    assert.deepEqual([...read], [[10,0],[11,0],[12,0]]);
    assert.deepEqual([...another], [[10,2],[11,0],[12,0]], 'outbound reply cannot replace user 8 personal read receipt');
    assert.equal(absent.get(10), 3);
    assert.equal((await count(9,[10],[73])).get(10), 0);
    assert.equal((await count(9,[11],[73])).get(11), 1);
    assert.equal((await count(null,[10])).get(10), 0);
    const [[afterMessages]] = await sql.query('SELECT COUNT(*) AS count FROM Messages');
    const [[afterReads]] = await sql.query('SELECT COUNT(*) AS count FROM ConversationReads');
    assert.deepEqual(afterMessages, beforeMessages); assert.deepEqual(afterReads, beforeReads);
    await sql.query("INSERT INTO Messages VALUES (10,10,'inbound','text',JSON_OBJECT(),'2030-01-07 10:06:00.000')");
    assert.equal((await count(7,[10])).get(10), 1, 'new inbound after a read receipt is personally unread');
    assert.equal((await count(8,[10])).get(10), 3);
    report.checks.push('Production unread SQL ran on the fixture-owned skip-networking MySQL only: per-user cutoff including same-time boundary, outbound-independent unread, event/hidden/QA exclusion, exact clinic and WhatsApp channel, missing actor fail-closed and later inbound; reads/messages unchanged by counter projections');
  });
});
