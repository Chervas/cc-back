'use strict';

// Explicit opt-in, owned Unix-socket MySQL and encrypted SQLite only. The real
// inbox capture/poll/import and managed JobRequest consumers are exercised;
// HTTP/session authentication, KMS and external intake/provider are NOT started.
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHmac, createHash } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitConsumerFixture } = require('./helpers/owned-visit-consumer-fixture');
const { SCHEMA, importLease } = require('../../lib/whatsappInboxImport');

test('actual encrypted inbox commits factual provider clock before ACK and releases the actual managed flow without another transport',
  { skip: process.env.WHATSAPP_INBOX_STATUS_CLOCK_MYSQL_TEST !== '1', timeout: 180000 }, async () => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createOwnedVisitConsumerFixture(context), { db } = f, query = f.sql.query.bind(f.sql);
      let rawConnection, secondConnection, store, cipher, key, inbox;
      const scope = { clinicId: 100, wabaId: '90002', phoneId: '90001' };
      const timestamp = String(Math.floor(Date.now() / 1000) - 60), factual = new Date(Number(timestamp) * 1000).toISOString();
      const secret = Buffer.from('OWNED_FAKE_STATUS_SECRET'), confirmed = [], expected = new Map();
      let clock = Date.now();
      try {
        const { BrokerStore } = require('../../../services/integrations-broker/src/store');
        const { createInboxCipher, createWhatsappInbox } = require('../../../services/integrations-broker/src/whatsapp-inbox');
        const { pollOnce } = require('../whatsapp-inbox-consumer');
        for (const ddl of SCHEMA) await f.sql.query(ddl);
        rawConnection = await f.sql.connectionManager.getConnection(); const connection = rawConnection.promise();
        secondConnection = await f.sql.connectionManager.getConnection(); const second = secondConnection.promise();
        key = randomBytes(32);
        const open = () => {
          store = new BrokerStore(context.report.root + '/status-inbox.sqlite');
          cipher = createInboxCipher({ key, keyId: 'owned-test' });
          inbox = createWhatsappInbox({ store, cipher, appId: '101', bindings: [{ wabaId: scope.wabaId, phoneIds: [scope.phoneId] }],
            auditContext: { tenantRef: 'clinic:100', connectionRef: 'owned-test', resourceRef: 'wa-inbox:101', policyVersion: 'owned-test-v1', operation: 'whatsapp.webhook.capture' },
            now: () => clock });
        };
        open();
        const packet = (statuses, patch = {}) => Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: scope.wabaId, changes: [
          { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: scope.phoneId }, statuses, ...patch } },
        ] }] }));
        const capture = (statuses, expectation) => {
          const raw = packet(statuses), signature = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
          const result = inbox.accept({ raw, appSecret: secret, signature });
          if (expectation) expected.set(result.receipt, expectation);
          return { ...result, raw };
        };
        const deniedRaw = packet([{ id: 'wamid.OWNED_auth_scope', status: 'sent', timestamp }]);
        assert.throws(() => inbox.accept({ raw: deniedRaw, appSecret: secret, signature: 'sha256=' + '0'.repeat(64) }), error => error.code === 'invalid_signature');
        for (const field of ['waba', 'phone']) {
          const foreign = JSON.parse(deniedRaw.toString());
          if (field === 'waba') foreign.entry[0].id = '90003'; else foreign.entry[0].changes[0].value.metadata.phone_number_id = '90003';
          const raw = Buffer.from(JSON.stringify(foreign));
          assert.throws(() => inbox.accept({ raw, appSecret: secret, signature: 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex') }), error => error.code === 'scope_denied');
        }
        assert.equal(store.db.prepare('SELECT COUNT(*) n FROM whatsapp_inbox').get().n, 0);
        const client = { async request(method, path, values) {
          if (path === '/pending') return { status: 200, data: { automaticActionsAllowed: false, receipts: inbox.pending(20), health: inbox.health() } };
          if (path === '/lease') {
            const leased = inbox.lease(values.receipt), rawBase64 = leased.raw.toString('base64'); leased.raw.fill(0);
            return { status: 200, data: { ...leased, raw: undefined, rawBase64 } };
          }
          if (path === '/defer') return { status: 200, data: inbox.defer(values) };
          if (path === '/confirm') {
            // Independent SQL connection can only see a COMMITTED receipt/row.
            const [[receipt]] = await second.execute('SELECT import_receipt FROM WhatsappInboxImports WHERE receipt=?', [values.receipt]);
            assert.equal(receipt.import_receipt, values.importReceipt);
            const wanted = expected.get(values.receipt);
            if (wanted) {
              const message = await db.Message.findByPk(wanted.id);
              assert.equal(message.status, wanted.status);
              assert.equal(message.sent_at?.toISOString() || null, wanted.sentAt);
              if (wanted.sentAt) assert.equal(message.metadata.wa_status_timestamps.sent, timestamp);
            }
            confirmed.push(values.receipt); return { status: 200, data: inbox.confirm(values) };
          }
          throw Error('UNEXPECTED_OWNED_INBOX_CALL');
        } };
        const poll = () => pollOnce(connection, client, { env: {}, scope, requiresScoped: false, loadConfiguration: () => null, publish: () => {} });
        const state = receipt => store.db.prepare('SELECT state FROM whatsapp_inbox WHERE receipt=?').get(receipt).state;
        const countReceipt = async receipt => (await second.execute('SELECT COUNT(*) n FROM WhatsappInboxImports WHERE receipt=?', [receipt]))[0][0].n;
        const lease = raw => ({ receipt: randomUUID(), lease: randomUUID(), automaticActionsAllowed: false, raw });

        // Real endpoint -> canonical command -> runtime -> Message -> actual job
        // handler -> controlled fake transport. Capture sent before WAMID commit.
        const response = await f.post(f.body()); assert.equal(response.statusCode, 201, JSON.stringify(response.body));
        const intent = await db.AppointmentVisitCommunication.findOne({ where: { owner_appointment_id: response.body.id_cita } });
        const execute = await db.JobRequest.findOne({ where: { type: 'automations_v2_execute', payload: { execution_id: Number(intent.execution_id) } } });
        assert.equal((await f.claimAndHandle(execute.id)).status, 'waiting'); await intent.reload();
        const message = await db.Message.findByPk(intent.message_id);
        const deliver = await db.JobRequest.findOne({ where: { type: 'appointment_visit_dispatch', payload: { visit_communication_id: intent.id } } });
        let intercepted = false, early;
        f.sql.query = async (sql, options) => {
          if (!intercepted && options?.replacements?.receipt && String(sql).includes('UPDATE `Messages`')) {
            intercepted = true; const acceptance = JSON.parse(options.replacements.receipt);
            early = capture([{ id: acceptance.wamid, status: 'sent', timestamp }], { id: message.id, status: 'sent', sentAt: factual });
            assert.equal(await poll(), 1);
            assert.equal(store.db.prepare('SELECT reason FROM whatsapp_inbox_retry WHERE receipt=?').get(early.receipt).reason, 'unmatched_status');
            assert.notEqual(state(early.receipt), 'imported'); assert.equal(await countReceipt(early.receipt), 0);
          }
          return query(sql, options);
        };
        try { assert.equal((await f.claimAndHandle(deliver.id)).result.outcome, 'accepted'); } finally { f.sql.query = query; }
        assert(intercepted); await message.reload(); assert.equal(message.status, 'pending'); assert.equal(message.sent_at, null);
        const encrypted = Buffer.from(store.db.prepare('SELECT body FROM whatsapp_inbox WHERE receipt=?').get(early.receipt).body);
        assert.equal(encrypted.includes(Buffer.from(timestamp)), false);
        cipher.close(); store.close(); open(); clock += 60001;
        assert.equal(inbox.pending(20)[0].receipt, early.receipt); assert.equal(await poll(), 1); assert.equal(state(early.receipt), 'imported');
        await message.reload(); assert.equal(message.status, 'sent'); assert.equal(message.sent_at.toISOString(), factual);
        assert.equal(message.metadata.wa_status_timestamps.sent, timestamp); assert.equal(message.metadata.wamid.startsWith('wamid.'), true);
        assert.equal(message.metadata.wa_status_history.length, 1); assert.equal(message.metadata.provider_acceptance_status, 'accepted');
        await execute.update({ next_run_at: new Date(Date.now() - 1000) });
        assert.equal((await f.claimAndHandle(execute.id)).status, 'completed');
        const attempts = f.attempts.length; await f.jobs.setPending(deliver.id);
        assert.equal((await f.claimAndHandle(deliver.id)).result.reason, 'accepted'); assert.equal(f.attempts.length, attempts);
        context.report.checks.push({ case: 'actual_encrypted_early_status_restart_commit_clock_ack_real_flow_completed', transports: attempts, factual_clock: factual, second_transport: false });

        const duplicate = capture([{ id: message.metadata.wamid, status: 'sent', timestamp }]);
        assert.equal(duplicate.receipt, early.receipt); assert.equal(duplicate.replayed, true); assert.equal(await poll(), 0);
        const replay = await importLease(connection, { ...lease(early.raw), receipt: early.receipt }, scope);
        assert.equal(replay.replayed, true); await message.reload(); assert.equal(message.metadata.wa_status_history.length, 1);
        for (const foreign of [{ ...scope, wabaId: '90003' }, { ...scope, phoneId: '90003' }, { ...scope, clinicId: 200 }]) {
          await assert.rejects(importLease(connection, { ...lease(early.raw), receipt: early.receipt }, foreign), error => error.inboxReason === 'review_required');
        }
        const changed = { ...lease(packet([{ id: message.metadata.wamid, status: 'sent', timestamp: String(Number(timestamp) + 1) }])), receipt: early.receipt };
        await assert.rejects(importLease(connection, changed, scope), error => error.inboxReason === 'review_required');
        context.report.checks.push('Exact ciphertext/receipt replay keeps history/clock once; mixed receipt payload rejected');

        const conversation = await db.Conversation.create({ clinic_id: 100, channel: 'whatsapp', contact_id: '19995550101' });
        const makeMessage = (wamid, patch = {}) => db.Message.create({ conversation_id: conversation.id, direction: 'outbound', status: 'pending',
          metadata: { wamid, private_binding: { retained: true }, provider_acceptance_status: 'held_for_quality_assessment' }, sent_at: null, ...patch });
        for (const advanced of ['delivered', 'read']) {
          const row = await makeMessage('wamid.OWNED_order_' + advanced);
          const first = capture([{ id: row.metadata.wamid, status: advanced, timestamp: String(Number(timestamp) + 1) }], { id: row.id, status: advanced, sentAt: null });
          assert.equal(await poll(), 1); assert.equal(state(first.receipt), 'imported'); await row.reload(); assert.equal(row.sent_at, null);
          const late = capture([{ id: row.metadata.wamid, status: 'sent', timestamp }], { id: row.id, status: advanced, sentAt: factual });
          assert.equal(await poll(), 1); assert.equal(state(late.receipt), 'imported'); await row.reload();
          assert.equal(row.status, advanced); assert.equal(row.sent_at.toISOString(), factual);
          assert.equal(row.metadata.wa_status_timestamps[advanced], String(Number(timestamp) + 1));
          assert.deepEqual(row.metadata.private_binding, { retained: true }); assert.equal(row.metadata.provider_acceptance_status, 'held_for_quality_assessment');
          const history = row.metadata.wa_status_history.length;
          await importLease(connection, { ...lease(late.raw), receipt: late.receipt }, scope); await row.reload(); assert.equal(row.metadata.wa_status_history.length, history);
        }
        const unclocked = await makeMessage('wamid.OWNED_unclocked_delivered');
        capture([{ id: unclocked.metadata.wamid, status: 'delivered' }], { id: unclocked.id, status: 'delivered', sentAt: null }); assert.equal(await poll(), 1);
        await unclocked.reload(); assert.equal(unclocked.sent_at, null);
        context.report.checks.push('Encrypted delivered/read before sent: no invented clock, late sent fills factual clock without status regression; duplicate receipt does not append');

        const invalid = await makeMessage('wamid.OWNED_invalid_clock'); await invalid.reload(); const beforeInvalid = invalid.toJSON();
        for (const value of [undefined, null, '', 'Infinity', 1791374400, '-1', '0', '1.5', '9007199254740992', String(Math.floor(Date.now() / 1000) + 3600)]) {
          const item = capture([{ id: invalid.metadata.wamid, status: 'sent', ...(value === undefined ? {} : { timestamp: value }) }]);
          assert.equal(await poll(), 1); assert.notEqual(state(item.receipt), 'imported');
          assert.equal(store.db.prepare('SELECT reason FROM whatsapp_inbox_retry WHERE receipt=?').get(item.receipt).reason, 'review_required');
          assert.equal(await countReceipt(item.receipt), 0); assert.equal(confirmed.includes(item.receipt), false);
        }
        await invalid.reload(); assert.deepEqual(invalid.toJSON(), beforeInvalid);
        context.report.checks.push('Encrypted missing/invalid/nonfinite/numeric/future sent clocks are retained for review without ACK, receipt, row mutation or guessed time');

        const protectedRow = await makeMessage('wamid.OWNED_scope_clock'); await protectedRow.reload(); const protectedBefore = protectedRow.toJSON();
        const protectedLease = lease(packet([{ id: protectedRow.metadata.wamid, status: 'sent', timestamp }]));
        for (const foreign of [{ ...scope, wabaId: '90003' }, { ...scope, phoneId: '90003' }, { ...scope, clinicId: 200 }]) {
          await assert.rejects(importLease(connection, protectedLease, foreign), error => ['review_required', 'unmatched_status'].includes(error.inboxReason));
        }
        let validations = 0;
        await assert.rejects(importLease(connection, protectedLease, scope, Date.now(), { validateScope: async () => {
          if (++validations === 2) throw Object.assign(Error('OWNED_SCOPE_CHANGED'), { inboxReason: 'review_required' });
        } }), error => error.inboxReason === 'review_required');
        assert.equal(validations, 2); await protectedRow.reload(); assert.deepEqual(protectedRow.toJSON(), protectedBefore);
        assert.equal(await countReceipt(protectedLease.receipt), 0);
        const inbound = await makeMessage('wamid.OWNED_wrong_direction', { direction: 'inbound' });
        await assert.rejects(importLease(connection, lease(packet([{ id: inbound.metadata.wamid, status: 'sent', timestamp }])), scope), error => error.inboxReason === 'unmatched_status');
        const internal = await db.Conversation.create({ clinic_id: 100, channel: 'internal', contact_id: '19995550102' });
        const otherChannel = await makeMessage('wamid.OWNED_wrong_channel', { conversation_id: internal.id });
        await assert.rejects(importLease(connection, lease(packet([{ id: otherChannel.metadata.wamid, status: 'sent', timestamp }])), scope), error => error.inboxReason === 'unmatched_status');
        const ambiguous = await makeMessage('wamid.OWNED_ambiguous_clock'), ambiguousTwin = await makeMessage('wamid.OWNED_ambiguous_clock');
        await assert.rejects(importLease(connection, lease(packet([{ id: ambiguous.metadata.wamid, status: 'sent', timestamp }])), scope), error => error.inboxReason === 'review_required');
        await ambiguous.reload(); await ambiguousTwin.reload(); assert.equal(ambiguous.sent_at, null); assert.equal(ambiguousTwin.sent_at, null);
        context.report.checks.push('WABA/phone/clinic/channel/outbound/WAMID ownership and final scope recheck retained; final recheck rolls back both status+clock and receipt');

        const concurrent = await makeMessage('wamid.OWNED_concurrent_clock');
        const a = lease(packet([{ id: concurrent.metadata.wamid, status: 'sent', timestamp }]));
        const b = lease(packet([{ id: concurrent.metadata.wamid, status: 'read', timestamp: String(Number(timestamp) + 1) }]));
        await Promise.all([importLease(connection, a, scope), importLease(second, b, scope)]);
        await concurrent.reload(); assert.equal(concurrent.status, 'read'); assert.equal(concurrent.sent_at.toISOString(), factual);
        assert.equal(concurrent.metadata.wa_status_history.length, 2); assert.deepEqual(concurrent.metadata.private_binding, { retained: true });
        // The real ORM webhook consumer has no importer GET_LOCK. Start it
        // after the inbox has taken its Message lock: its eventual CURRENT merge
        // must retain the just-committed sent clock/history and binding.
        const interleaved = await makeMessage('wamid.OWNED_orm_clock_interleave');
        const originalExecute = connection.execute.bind(connection); let hit = false, providerPending;
        connection.execute = async (sql, values) => {
          const result = await originalExecute(sql, values);
          if (!hit && String(sql).startsWith('SELECT m.id,m.status,m.metadata,m.sent_at') && values[1] === interleaved.metadata.wamid) {
            hit = true; providerPending = require('../../lib/whatsapp-provider-status').persistProviderStatus({ db, messageId: interleaved.id,
              status: { status: 'read', timestamp: String(Number(timestamp) + 1) } });
            await new Promise(resolve => setImmediate(resolve));
          }
          return result;
        };
        try { await importLease(connection, lease(packet([{ id: interleaved.metadata.wamid, status: 'sent', timestamp }])), scope); }
        finally { connection.execute = originalExecute; }
        assert(hit); await providerPending; await interleaved.reload();
        assert.equal(interleaved.status, 'read'); assert.equal(interleaved.sent_at.toISOString(), factual);
        assert.deepEqual(interleaved.metadata.wa_status_history.map(item => item.status), ['sent', 'read']);
        assert.deepEqual(interleaved.metadata.private_binding, { retained: true });
        const failure = await makeMessage('wamid.OWNED_failure_clock');
        await importLease(connection, lease(packet([{ id: failure.metadata.wamid, status: 'failed', errors: [{ code: 131026 }] }])), scope);
        await importLease(connection, lease(packet([{ id: failure.metadata.wamid, status: 'sent', timestamp }])), scope);
        await failure.reload(); assert.equal(failure.status, 'sent'); assert.equal(failure.sent_at.toISOString(), factual); assert.equal(failure.metadata.wa_error[0].code, 131026);
        context.report.checks.push('Concurrent SQL imports plus real ORM webhook after importer row lock preserve advanced status, CURRENT binding/history and factual clock; existing inbox failure recovery/error evidence preserved');

        // Historical imports are tombstones, not authorization to reopen/repair.
        const oldRow = await makeMessage('wamid.OWNED_old_receipt', { status: 'sent' });
        const oldLease = lease(packet([{ id: oldRow.metadata.wamid, status: 'sent' }])), oldImport = randomUUID();
        await second.execute('INSERT INTO WhatsappInboxImports VALUES(?,?,?,?,?,?,NOW(3))', [oldLease.receipt, createHash('sha256').update(oldLease.raw).digest('hex'), oldImport, scope.clinicId, scope.phoneId, 0]);
        assert.deepEqual(await importLease(connection, oldLease, scope), { importReceipt: oldImport, replayed: true });
        await oldRow.reload(); assert.equal(oldRow.sent_at, null); assert.equal(oldRow.metadata.wa_status_history, undefined);
        context.report.checks.push('Exact already-imported legacy receipt replays without opening history or fabricating/repairing clocks');
        assert.equal(f.attempts.length, attempts);
      } finally {
        f.sql.query = query; cipher?.close(); store?.close(); key?.fill(0); secret.fill(0);
        if (secondConnection) await f.sql.connectionManager.releaseConnection(secondConnection);
        if (rawConnection) await f.sql.connectionManager.releaseConnection(rawConnection);
        await f.close();
      }
    });
  });
