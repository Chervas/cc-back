'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createInboxDatabaseSession, OWNER_LOCK } = require('../../lib/whatsappInboxDatabaseSession');
const { SCHEMA } = require('../../lib/whatsappInboxImport');
const { pollOnce } = require('../whatsapp-inbox-consumer');

test('owned importer restarts reacquire one writer session and reconcile a committed receipt whose ACK was lost', async () => {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    const mysql = require('mysql2/promise'), sessions = [];
    const create = () => {
      const session = createInboxDatabaseSession({ connect: () => mysql.createConnection({
        socketPath: sql.options.dialectOptions.socketPath, database: report.database, user: 'root', password: '',
      }), tables: ['WhatsappInboxImports', 'WhatsappInboxMessageKeys', 'WhatsappInboxContactKeys'] });
      sessions.push(session); return session;
    };
    await sql.query('CREATE TABLE Clinicas(id_clinica INT PRIMARY KEY)'); await sql.query('INSERT INTO Clinicas VALUES(71)');
    await sql.query('CREATE TABLE Conversations(id INT PRIMARY KEY AUTO_INCREMENT,clinic_id INT,channel VARCHAR(20),contact_id VARCHAR(32),unread_count INT,last_message_at DATETIME(3),last_inbound_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))');
    await sql.query('CREATE TABLE Messages(id INT PRIMARY KEY AUTO_INCREMENT,conversation_id INT,direction VARCHAR(20),content TEXT,message_type VARCHAR(20),status VARCHAR(20),metadata JSON,sent_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))');
    for (const ddl of SCHEMA) await sql.query(ddl);
    try {
      const first = create(), connection = await first.open();
      const contender = create(); await assert.rejects(contender.open(), { code: 'inbox_consumer_owner_exists' }); await contender.close();
      const [[owner]] = await connection.query('SELECT CONNECTION_ID() AS id,IS_USED_LOCK(?) AS owner', [OWNER_LOCK]);
      assert.equal(Number(owner.id), Number(owner.owner));
      const receipt = randomUUID(), lease = randomUUID(), calls = [];
      const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '101', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: '201' }, messages: [{ id: 'wamid.synthetic-session-recovery', from: '19995550101',
          timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'synthetic passive fixture' } }],
      } }] }] }));
      const client = { request: async (method, route) => {
        calls.push(route);
        if (route === '/pending') return { status: 200, data: { automaticActionsAllowed: false, receipts: [{ receipt }] } };
        if (route === '/lease') return { status: 200, data: { receipt, lease, automaticActionsAllowed: false, receivedAt: Date.now(), recoveryWithoutAutomation: true, rawBase64: raw.toString('base64') } };
        return { status: 200, data: { businessProcessed: true } };
      } };
      const options = session => ({ env: {}, scope: { clinicId: 71, wabaId: '101', phoneId: '201' }, requiresScoped: false,
        loadConfiguration: () => null, publish: () => {}, assertDatabaseOwnership: () => session.assertOwnership() });
      const commit = connection.commit.bind(connection); let commits = 0;
      connection.commit = async () => { commits++; await commit(); connection.destroy(); throw Object.assign(Error('synthetic lost commit ACK'), { code: 'PROTOCOL_CONNECTION_LOST' }); };
      await pollOnce(connection, client, options(first));
      assert.equal(commits, 1); assert.equal(calls.includes('/confirm'), false); assert.equal(calls.filter(route => route === '/defer').length, 1);
      await assert.rejects(first.assertOwnership(), { code: 'inbox_database_session_unavailable' }); await first.close();
      const [[before]] = await sql.query('SELECT import_receipt FROM WhatsappInboxImports WHERE receipt=:receipt', { replacements: { receipt } }); assert(before);
      const restarted = create(), fresh = await restarted.open();
      await pollOnce(fresh, client, options(restarted));
      assert.equal(calls.filter(route => route === '/confirm').length, 1);
      const [[after]] = await sql.query('SELECT COUNT(*) AS n,MAX(import_receipt) AS import_receipt FROM WhatsappInboxImports');
      assert.equal(Number(after.n), 1); assert.equal(after.import_receipt, before.import_receipt);
      const [[message]] = await sql.query('SELECT COUNT(*) AS n,MAX(CAST(metadata AS CHAR)) AS metadata FROM Messages');
      assert.equal(Number(message.n), 1);
      const metadata = JSON.parse(message.metadata); assert.equal(metadata.recovery_without_automation, true); assert.equal(metadata.automatic_actions_allowed, false);
      const [[conversation]] = await sql.query('SELECT COUNT(*) AS n,SUM(unread_count) AS unread FROM Conversations');
      assert.equal(Number(conversation.n), 1); assert.equal(Number(conversation.unread), 1);
      report.checks.push('single owner excludes contender; lost commit ACK leaves one durable receipt/message; fresh supervisor session reacquires GET_LOCK and ACKs exact receipt without unread/message duplication or automation');

      const [[active]] = await fresh.query('SELECT CONNECTION_ID() AS id');
      assert(Number.isSafeInteger(Number(active.id))); await sql.query('KILL CONNECTION ' + Number(active.id));
      await assert.rejects(restarted.assertOwnership(), { code: 'inbox_database_session_unavailable' }); await restarted.close();
      const third = create(), thirdConnection = await third.open();
      await thirdConnection.execute('SELECT RELEASE_LOCK(?)', [OWNER_LOCK]);
      await assert.rejects(third.assertOwnership(), { code: 'inbox_database_owner_lost' }); await third.close();
      report.checks.push('server-closed connection and lost advisory ownership cannot continue polling and require a new supervisor-owned session');

      await sql.query('SET GLOBAL super_read_only=ON');
      const replica = create(); await assert.rejects(replica.open(), { code: 'inbox_database_writer_required' }); await replica.close();
      await sql.query('SET GLOBAL super_read_only=OFF'); await sql.query('SET GLOBAL read_only=OFF');
      const writer = create(); await writer.open(); await writer.assertOwnership();
      report.checks.push('read-only target rejected before ownership, restored writer accepts a newly validated session');
      raw.fill(0);
    } finally {
      await sql.query('SET GLOBAL super_read_only=OFF').catch(() => {}); await sql.query('SET GLOBAL read_only=OFF').catch(() => {});
      for (const session of sessions) await session.close();
    }
  });
});
