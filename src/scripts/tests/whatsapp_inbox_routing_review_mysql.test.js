'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const scopes = require('../../lib/whatsappInboxScopes');
const routing = require('../../lib/whatsappInboxRoutingReview');
const { SCHEMA } = require('../../lib/whatsappInboxImport');

test('shared-phone clinic selection is durable, authorized, race-safe and never replays recovered automation', async () => {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    await sql.query('CREATE TABLE Clinicas(id_clinica INT PRIMARY KEY,grupoClinicaId INT,nombre_clinica VARCHAR(100))');
    await sql.query("INSERT INTO Clinicas VALUES(71,9,'FICTITIOUS CLINIC A'),(72,9,'FICTITIOUS CLINIC B')");
    await sql.query('CREATE TABLE ClinicMetaAssets(id INT PRIMARY KEY,assignmentScope VARCHAR(20),clinicaId INT,grupoClinicaId INT,assetType VARCHAR(40),phoneNumberId VARCHAR(30),wabaId VARCHAR(30))');
    await sql.query("INSERT INTO ClinicMetaAssets VALUES(83,'group',NULL,9,'whatsapp_phone_number','203','103')");
    await sql.query('CREATE TABLE PatientDirectionSettings(clinic_id INT,director_phone_asset_id INT)');
    await sql.query('CREATE TABLE MetaScopeBlocks(scope_key VARCHAR(100) PRIMARY KEY)');
    await sql.query('CREATE TABLE Conversations(id INT PRIMARY KEY AUTO_INCREMENT,clinic_id INT,channel VARCHAR(20),contact_id VARCHAR(32),patient_id INT,lead_id INT,unread_count INT,last_message_at DATETIME(3),last_inbound_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))');
    await sql.query('CREATE TABLE Messages(id INT PRIMARY KEY AUTO_INCREMENT,conversation_id INT,direction VARCHAR(20),content TEXT,message_type VARCHAR(20),status VARCHAR(20),metadata JSON,sent_at DATETIME(3),createdAt DATETIME(3),updatedAt DATETIME(3))');
    for (const ddl of [...SCHEMA.filter(s => !s.includes('WhatsappInboxAdminSync') && !s.includes('WhatsappInboxPlaybackImports')), ...routing.SCHEMA]) await sql.query(ddl);
    await sql.query("INSERT INTO Conversations(id,clinic_id,channel,contact_id,patient_id,unread_count) VALUES(100,71,'whatsapp','19995550101',1,0),(200,72,'whatsapp','+19995550101',2,0)");
    const scope = { assetId: 83, phoneId: '203', wabaId: '103', clinicIds: [71,72] };
    const config = { version: 1, scopes: [scope] };
    const now = Date.now();
    const make = suffix => ({ receipt: randomUUID(), lease: randomUUID(), receivedAt: now, automaticActionsAllowed: false,
      scopeBindings: [{ phoneId: '203', wabaId: '103', clinicIds: [71,72] }],
      raw: Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '103', changes: [{ field: 'messages',
        value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '203' }, messages: [{ id: 'wamid.synthetic_' + suffix, from: '19995550101',
          timestamp: String(Math.floor(now / 1000)), type: 'text', text: { body: 'FICTITIOUS ROUTING TEST' } }] } }] }] })) });
    const connection = await sql.connectionManager.getConnection(); const c = connection.promise();
    const allow = async () => true;
    try {
      const first = make('first'); const second = make('second');
      await assert.rejects(scopes.importScopedLease(c, first, config, { routingReviewEnabled: false }), /review_required/);
      assert.equal((await sql.query('SELECT COUNT(*) n FROM WhatsappInboxRoutingReviews'))[0][0].n, 0);
      for (const lease of [first, first, second]) await assert.rejects(scopes.importScopedLease(c, lease, config, { routingReviewEnabled: true }), /review_required/);
      assert.equal((await sql.query('SELECT COUNT(*) n FROM Messages'))[0][0].n, 0);
      const pending = await routing.pending(c, [100,200], allow);
      assert.equal(pending.length, 1); assert.equal(pending[0].pendingCount, 2);
      assert.deepEqual(pending[0].clinics.map(c => c.id), [71,72]);
      assert.deepEqual(await routing.pending(c, [100], async conversation => conversation.clinic_id === 71), []);
      const row = pending[0];
      const request = { reviewId: row.id, revision: row.revision, conversationId: 100, clinicId: 71, userId: 44, scopes: config.scopes, authorize: allow };
      await assert.rejects(routing.resolve(c, { ...request, conversationId: 999 }), { code: 'routing_review_forbidden' });
      await assert.rejects(routing.resolve(c, { ...request, authorize: async () => false }), { code: 'routing_review_forbidden' });
      await assert.rejects(routing.resolve(c, { ...request, revision: 9 }), { code: 'routing_review_changed' });
      await assert.rejects(routing.resolve(c, { ...request, clinicId: 99 }), { code: 'routing_candidates_unavailable' });
      await assert.rejects(routing.resolve(c, { ...request, scopes: [{ ...scope, assetId: 999 }] }), { code: 'routing_scope_changed' });
      await sql.query("INSERT INTO MetaScopeBlocks VALUES('group:9')");
      await assert.rejects(routing.resolve(c, request), /review_required/); await sql.query('DELETE FROM MetaScopeBlocks');
      await routing.resolve(c, request);
      await assert.rejects(routing.resolve(c, { ...request, clinicId: 72 }), { code: 'routing_review_changed' });
      const [[stored]] = await sql.query('SELECT status,selected_clinic_id,selected_conversation_id,resolved_by FROM WhatsappInboxRoutingReviews');
      assert.deepEqual(stored, { status: 'resolved', selected_clinic_id: 71, selected_conversation_id: 100, resolved_by: 44 });
      assert.deepEqual(await routing.pending(c, [100,200], allow), []);
      const part = scopes.splitLease(first, config)[0];
      assert.equal((await routing.decision(c, part, { receipt: first.receipt, partIndex: 0 })).recovered, true);
      const altered = structuredClone(part); altered.packet.entry[0].changes[0].value.messages[0].text.body = 'FICTITIOUS TAMPER';
      await assert.rejects(routing.decision(c, altered, { receipt: first.receipt, partIndex: 0 }), { code: 'routing_receipt_changed' });
      assert.equal(await routing.decision(c, { ...part, scope: { ...scope, phoneId: '204' } }), null);
      let resumed = 0;
      const resumeClient = { request: async (method,path,body) => {
        assert.equal(method, 'POST'); assert.equal(path, '/resume-review'); assert.ok([first.receipt,second.receipt].includes(body.receipt));
        resumed++; return { status: 200, data: { retryScheduled: true, businessProcessed: false } };
      } };
      await routing.resumeResolved(c, resumeClient, config.scopes);
      assert.equal(resumed, 1);
      await routing.resumeResolved(c, resumeClient, config.scopes);
      assert.equal(resumed, 2);
      await routing.resumeResolved(c, { request: async () => { throw Error('not due'); } }, config.scopes);
      await sql.query('UPDATE WhatsappInboxRoutingReviewReceipts SET retry_requested_at=NULL');
      let failedAttempts = 0;
      assert.equal((await routing.resumeResolved(c, { request: async () => { failedAttempts++; throw Error('FICTITIOUS TRANSPORT FAILURE'); } }, config.scopes)).retryScheduled, false);
      assert.equal(failedAttempts, 1);
      assert.equal((await sql.query('SELECT COUNT(*) n FROM WhatsappInboxRoutingReviewReceipts WHERE retry_requested_at IS NOT NULL'))[0][0].n, 1);
      for (const lease of [first, first, second]) await scopes.importScopedLease(c, lease, config, { routingReviewEnabled: true });
      const messages = (await sql.query('SELECT conversation_id,metadata FROM Messages ORDER BY id'))[0];
      assert.equal(messages.length, 2);
      assert.ok(messages.every(m => m.conversation_id === 100 && m.metadata.recovery_without_automation === true && m.metadata.automatic_actions_allowed === false));
      const fresh = make('fresh'); await scopes.importScopedLease(c, fresh, config, { routingReviewEnabled: true });
      const [[freshMessage]] = await sql.query('SELECT metadata FROM Messages ORDER BY id DESC LIMIT 1');
      assert.equal(freshMessage.metadata.recovery_without_automation, false);
      assert.equal(freshMessage.metadata.automatic_actions_allowed, false);
      assert.equal((await sql.query('SELECT COUNT(*) n FROM Conversations'))[0][0].n, 2);
      assert.equal((await sql.query('SELECT COUNT(*) n FROM WhatsappInboxRoutingReviews'))[0][0].n, 1);
      assert.equal((await sql.query('SELECT COUNT(*) n FROM WhatsappInboxRoutingReviewReceipts WHERE imported_at IS NULL'))[0][0].n, 0);
      await sql.query('UPDATE Conversations SET clinic_id=72 WHERE id=100');
      await assert.rejects(scopes.importScopedLease(c, make('stale'), config, { routingReviewEnabled: true }), { code: 'routing_conversation_changed' });
      await sql.query("INSERT INTO Conversations(id,clinic_id,channel,contact_id,unread_count) VALUES(300,71,'whatsapp','19995550102',0),(400,72,'whatsapp','19995550102',0)");
      const concurrent = make('concurrent');
      const concurrentBody = JSON.parse(concurrent.raw); concurrentBody.entry[0].changes[0].value.messages[0].from = '19995550102';
      concurrent.raw = Buffer.from(JSON.stringify(concurrentBody));
      await assert.rejects(scopes.importScopedLease(c, concurrent, config, { routingReviewEnabled: true }), /review_required/);
      const [concurrentReview] = await routing.pending(c, [300], allow);
      const otherConnection = await sql.connectionManager.getConnection();
      try {
        const common = { ...request, conversationId: 300, reviewId: concurrentReview.id, revision: concurrentReview.revision };
        const outcomes = await Promise.allSettled([
          routing.resolve(c, { ...common, clinicId: 71 }),
          routing.resolve(otherConnection.promise(), { ...common, clinicId: 72 }),
        ]);
        assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
        assert.equal(outcomes.find(o => o.status === 'rejected').reason.code, 'routing_review_changed');
      } finally { await sql.connectionManager.releaseConnection(otherConnection); }
      report.checks.push('disabled compatibility, deduplicated card, both-clinic access, stale selection, scope block, passive recovery, no historical AI, fresh dispatcher eligibility and physical-number isolation');
    } finally { await sql.connectionManager.releaseConnection(connection); }
  });
});
