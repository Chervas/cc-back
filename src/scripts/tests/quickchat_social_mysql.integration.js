'use strict';
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
const D = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const social = require('../../services/socialInbox.service');
const { events, eventKey } = require('../../services/socialInboxEvents');
const broker = require('../../../services/integrations-broker/src/meta-marketing-social');
const migration = require('../../../migrations/20261126180000-quickchat-social');
const { createMetaLeadWebhookHandlers } = require('../../services/metaLeadWebhook.service');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.Sequelize = D;
  const q = sql.getQueryInterface(),
    at = Date.now(),
    jobs = [],
    packets = [],
    dispatched = [],
    calls = [];
  await q.createTable('Clinicas', { id_clinica: { type: D.INTEGER, primaryKey: true } });
  await q.createTable('Pacientes', { id_paciente: { type: D.INTEGER, primaryKey: true } });
  await q.createTable('Leads', { id: { type: D.INTEGER, primaryKey: true } });
  await require('../../../migrations/20260201100000-create-conversations').up(q, D);
  await sql.query('INSERT INTO Clinicas VALUES (41),(42)');
  await sql.query(
    "INSERT INTO Conversations(clinic_id,channel,contact_id,createdAt,updatedAt) VALUES(41,'whatsapp','qa-wa',NOW(),NOW())",
  );
  const policy = require('../../lib/rdsSchemaMigrationPolicy');
  const name = '20261126180000-quickchat-social.js',
    source = require('node:path').resolve(__dirname, '../../..');
  const pins = policy.migrationFiles(source, [name]),
    loaded = policy.loadMigration(source, name, pins, D);
  const raw = await sql.connectionManager.getConnection();
  const guard = require('../../lib/rdsSchemaMigration').migrationInterface({
    admin: { raw, identity: { database: report.database, engineVersion: report.mysql } },
    aws: { assertFresh() {} },
    journal: () => {},
    migrationName: name,
    Sequelize: D,
  });
  try {
    await loaded.migration.up(guard.queryInterface, loaded.facade);
  } finally {
    await guard.restore();
    await sql.connectionManager.releaseConnection(raw);
  }
  await migration.up(q, D);
  const contract = require('../../../ops/security/schema-contract.json');
  assert.equal(
    contract.migrations.find((r) => r.name === name).sha256,
    pins.find((r) => r.path.endsWith(name)).sha256,
  );
  const schema = require('../../lib/securitySchemaContract');
  const snapshot = await schema.snapshot((statement, replacements) =>
    sql.query(statement, { type: D.QueryTypes.SELECT, replacements }),
  );
  const check = schema.compare(snapshot, {
    tables: {
      Conversations: contract.tables.Conversations,
      SocialInboxReceipts: contract.tables.SocialInboxReceipts,
    },
    migrations: [],
  });
  assert(check.compatible, JSON.stringify(check.issues));

  db.Conversation = require('../../../models/conversation')(sql, D.DataTypes);
  db.Message = require('../../../models/message')(sql, D.DataTypes);
  await db.Message.sync();
  db.SocialInboxReceipt = require('../../../models/socialinboxreceipt')(sql, D.DataTypes);
  assert.equal((await db.Conversation.findOne()).channel, 'whatsapp');
  const accounts = { 501: 41, 502: 42, 401: 41 };
  const resolve = async (_db, { accountId, channel }) =>
    accounts[accountId]
      ? {
          appId: '123',
          accountId,
          channel,
          clinicId: accounts[accountId],
          pageId: accountId === '502' ? '402' : '401',
          tenantRef: 'clinic:41',
          connectionRef: 'shared-test',
          enrollmentId: 'synthetic',
        }
      : null;
  let denied = false,
    unknown = false,
    proof = null;
  const provider = {
    availability: async (r) =>
      denied
        ? { available: false, reason: 'permission:instagram_manage_messages' }
        : { available: true, accountName: r.channel === 'instagram' ? '@demo' : 'Página demo' },
    send: async (r, kind, recipient, text, id) => {
      calls.push({ r, kind, recipient, text, id });
      if (unknown) throw Error('timeout');
      return { available: true, messageId: 'mid-out-' + id, recipientId: '771' };
    },
    reconcile: async () => proof || { available: false, reason: 'reconciliation_required' },
  };
  const post = { mediaType: 'IMAGE', caption: 'Sesión informativa de prueba', previewUrl: 'https://example.cdninstagram.com/post.jpg' };
  provider.receive = async (r, e) => ({ ...await provider.availability(r, e.type), ...(e.type === 'comment' ? { post } : {}) });
  let redisUnavailable = false;
  const svc = social.create({
    db,
    provider,
    resolve,
    now: () => at,
    dispatchInbound: ({ entry }) => dispatched.push(entry.eventId),
    publish: (c, m, event) => {
      if (redisUnavailable) throw Error('realtime_bus_unavailable');
      packets.push([c.id, m.id, event]);
    },
    enqueue: async (job) => jobs.push(job),
  });
  const dm = (accountId, id, delta = 0, echo = false) => ({
    object: accountId === '401' ? 'page' : 'instagram',
    entry: [
      {
        id: accountId,
        messaging: [
          {
            sender: { id: echo ? accountId : '771' },
            recipient: { id: echo ? '771' : accountId },
            timestamp: at + delta,
            message: { text: 'Mensaje ficticio', mid: id, is_echo: echo },
          },
        ],
      },
    ],
  });
  const comment = (id, delta = 0) => ({
    object: 'instagram',
    entry: [
      {
        id: '501',
        time: Math.floor((at + delta) / 1000),
        changes: [
          {
            field: 'comments',
            value: {
              id,
              from: { id: '771', username: 'persona_ficticia' },
              text: 'INFO',
              media: { id: '881', permalink: 'https://www.instagram.com/clinica.demo/p/FICTICIO/?igsh=test' },
            },
          },
        ],
      },
    ],
  });
  const secret = Buffer.from('a'.repeat(32)),
    env = {
      META_SOCIAL_INBOX_RECEIVER_ENABLED: 'true',
      RUNTIME_ROLE: 'gateway',
      AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE: 'staging',
    };
  const handler = createMetaLeadWebhookHandlers({
    env,
    socialVerify: async (raw, signature) => {
      const routes = [
        { channel: 'instagram', accountId: '501', clinicId: 41 },
        { channel: 'instagram', accountId: '502', clinicId: 42 },
        { channel: 'messenger', accountId: '401', clinicId: 41 },
        { channel: 'instagram', accountId: '999', clinicId: 41 },
      ];
      return { appId: '123', ...broker.verifyBody({ rawBase64: raw.toString('base64'), signature }, secret, routes) };
    },
    socialAccept: svc.accept,
  });
  async function webhook(body, bad = false, drain = true) {
    const raw = Buffer.from(JSON.stringify(body)),
      sig =
        'sha256=' +
        createHmac('sha256', bad ? 'wrong' : secret)
          .update(raw)
          .digest('hex');
    const response = {
      set() {
        return this;
      },
      status(n) {
        this.code = n;
        return this;
      },
      json() {
        return this;
      },
    };
    await handler.receive(
      {
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
        rawHeaders: ['X-Hub-Signature-256', sig],
        rawBody: raw,
      },
      response,
    );
    assert.equal(response.code, bad ? 401 : 200);
    while (drain && jobs.length) await svc.importReceipt(jobs.shift().payload.receiptKey);
  }
  await webhook(comment('991'), true);
  assert.equal(await db.SocialInboxReceipt.count(), 0);
  const outside = dm('777', 'unconnected-in-same-app');
  await webhook(outside);
  assert.equal(await db.SocialInboxReceipt.count(), 0);
  const selected = comment('991');
  await webhook({ ...selected, entry: [...outside.entry, ...selected.entry] });
  assert.equal(await db.SocialInboxReceipt.count(), 1);
  await webhook(comment('991'));
  let thread = await db.Conversation.findOne({ where: { social_account_id: '501' } });
  assert.equal(thread.lead_id, null);
  assert.equal(thread.patient_id, null);
  assert.equal(thread.last_inbound_at, null);
  const m = await db.Message.findOne();
  assert.equal(m.metadata.social.permalink, 'https://www.instagram.com/clinica.demo/p/FICTICIO/');
  assert.deepEqual(m.metadata.social.post, post);
  assert.deepEqual((await svc.readEntry(eventKey(events(comment('991'))[0]), 41)).post, post);
  assert.equal(await db.Message.count(), 1);
  const reply = (args = {}) =>
    svc.reply(thread, { actorId: 1, text: 'Respuesta ficticia', attemptId: randomUUID(), ...args });
  const [a, b] = await Promise.all([
    reply({ commentMessageId: m.id }),
    reply({ commentMessageId: m.id }),
  ]);
  assert.equal(calls.length, 1);
  assert([a, b].some((r) => r.outcome === 'sent'));
  assert([a, b].some((r) => r.available === false));
  assert.equal(calls[0].recipient, '991');
  const prior = await reply({ commentMessageId: m.id, attemptId: calls[0].id });
  assert.equal(prior.outcome, 'sent');
  assert.equal(calls.length, 1);
  assert.deepEqual((await svc.availability(thread, [await m.reload()])).comments[m.id], {
    available: false, reason: 'private_reply_reserved', outcome: 'sent',
  });
  await webhook(dm('501', 'mid-1'));
  await webhook(dm('501', 'mid-1'));
  const inputKey = eventKey(events(dm('501', 'mid-1'))[0]);
  const entry = await svc.readEntry(inputKey, 41);
  assert.equal(entry.conversationId, thread.id);
  assert.equal(entry.source, 'new');
  assert.equal(await svc.readEntry(inputKey, 42), null);
  await thread.reload();
  assert(thread.last_inbound_at);
  assert.equal(await db.Message.count({ where: { conversation_id: thread.id } }), 3);
  assert.equal((await reply()).outcome, 'sent');
  assert.equal(calls.at(-1).recipient, '771');
  await webhook(dm('502', 'mid-1'));
  await webhook(dm('401', 'mid-1'));
  const other = await db.Conversation.findOne({ where: { social_account_id: '502' } }),
    messenger = await db.Conversation.findOne({ where: { channel: 'messenger' } });
  assert.equal(other.clinic_id, 42);
  assert.equal(messenger.clinic_id, 41);
  assert.notEqual(thread.id, other.id);
  assert.equal(
    (await svc.reply(messenger, { actorId: 1, text: 'prueba', attemptId: randomUUID() })).reason,
    'messenger_receive_only',
  );
  await webhook(dm('999', 'ambiguous'));
  assert.equal(
    (await db.SocialInboxReceipt.findByPk(eventKey(events(dm('999', 'ambiguous'))[0]))).state,
    'review',
  );
  denied = true;
  assert.equal((await reply()).reason, 'permission:instagram_manage_messages');
  denied = false;
  await webhook(comment('992', -8 * 86400000));
  const old = await db.Message.findOne({ where: { 'metadata.providerId': '992' } });
  assert.equal((await reply({ commentMessageId: old.id })).reason, 'comment_window_closed');
  await thread.update({ last_inbound_at: new Date(at - 2 * 86400000) });
  assert.equal((await reply()).reason, 'dm_window_closed');
  await webhook(dm('501', 'mid-fresh'));
  await thread.reload();
  unknown = true;
  const uncertain = await reply();
  assert.equal(uncertain.outcome, 'unknown');
  const blockedComments = (await svc.availability(thread, [m, old])).comments;
  assert.equal(blockedComments[m.id].outcome, 'sent');
  assert.deepEqual(blockedComments[old.id], { available: false, reason: 'reconciliation_required' });
  const n = calls.length;
  assert.equal((await reply()).reason, 'reconciliation_required');
  assert.equal(calls.length, n);
  await webhook(dm('501', 'confirmed-mid', 0, true));
  proof = { available: true, messageId: 'confirmed-mid', recipientId: '771' };
  const rows = await db.Message.findAll({ where: { conversation_id: thread.id }, raw: true });
  assert((await svc.availability(thread, rows)).dm.available);
  assert.equal(calls.length, n);
  await webhook(dm('501', 'confirmed-mid', 0, true));
  assert.equal(await db.Message.count({ where: { 'metadata.providerId': 'confirmed-mid' } }), 1);
  const history = dm('501', 'history-mid', -10 * 86400000);
  await svc.accept(history, { appId: '123', namespace: 'dev', history: true });
  await svc.importReceipt(jobs.pop().payload.receiptKey);
  assert.equal(
    (await db.SocialInboxReceipt.findByPk(eventKey(events(history)[0]))).event.source,
    'history',
  );
  const liveAfterImport = dm('501', 'same-event-history-and-live');
  const pinnedRoute = await resolve(db, { channel: 'instagram', accountId: '501' });
  await assert.rejects(svc.accept(liveAfterImport, { appId: '123', namespace: 'dev', history: true,
    expectedRoute: { ...pinnedRoute, clinicId: 999 } }), /route_changed/);
  const imported = await svc.accept(liveAfterImport, { appId: '123', namespace: 'dev', history: true, expectedRoute: pinnedRoute });
  assert.equal(imported.queued, 1);
  await svc.importReceipt(jobs.pop().payload.receiptKey);
  assert.equal((await svc.accept(liveAfterImport, { appId: '123', namespace: 'dev', history: true })).duplicate, 1);
  await svc.accept(liveAfterImport, { appId: '123', namespace: 'dev' });
  await svc.importReceipt(jobs.pop().payload.receiptKey);
  const merged = await db.Message.findAll({ where: { 'metadata.providerId': 'same-event-history-and-live' } });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].metadata.social.source, 'new');
  const delayed = dm('501', 'mid-delayed-notification');
  await svc.accept(delayed, { appId: '123', namespace: 'dev' });
  const delayedKey = jobs.pop().payload.receiptKey;
  redisUnavailable = true;
  await assert.rejects(svc.importReceipt(delayedKey), /realtime_bus_unavailable/);
  assert.equal((await db.SocialInboxReceipt.findByPk(delayedKey)).state, 'notify');
  redisUnavailable = false;
  await svc.importReceipt(delayedKey);
  assert.equal((await db.SocialInboxReceipt.findByPk(delayedKey)).state, 'persisted');
  assert.equal(
    await db.Message.count({ where: { 'metadata.providerId': 'mid-delayed-notification' } }),
    1,
  );
  // A real webhook can arrive while the account is assigned and its permissions
  // are being renewed. Reprocessing keeps the signed event and uses the ordinary worker.
  const heldComment = comment('8912345');
  denied = true;
  await svc.accept(heldComment, { appId: '123', namespace: 'dev' });
  const heldKey = jobs.pop().payload.receiptKey;
  await svc.importReceipt(heldKey);
  const held = await db.SocialInboxReceipt.findByPk(heldKey);
  assert.equal(held.state, 'review');
  const stored = structuredClone(held.event);
  const { retryReviewedReceipt } = require('../../services/socialInboxIntake.service');
  const retry = (clinicId, enqueue = async (job) => jobs.push(job)) => retryReviewedReceipt(db, heldKey, {
    clinicId, channel: stored.channel, accountId: stored.accountId, namespace: 'dev',
  }, { resolve, enqueue });
  assert.equal(await retry(42), false);
  const denial = held.reason;
  await held.update({ reason: 'post_owner_unverified' });
  assert.equal(await retry(41), false);
  await held.update({ reason: denial });
  accounts[stored.accountId] = 42;
  assert.equal(await retry(42), false);
  accounts[stored.accountId] = 41;
  await assert.rejects(retry(41, async () => { throw Error('queue_unavailable'); }), /queue_unavailable/);
  assert.equal((await held.reload()).state, 'review');
  const historyOptions = { appId: '123', namespace: 'dev', history: true, expectedRoute: held.route };
  const replacement = structuredClone(heldComment);
  replacement.entry[0].changes[0].value.from.id = '993';
  assert.equal((await svc.accept(replacement, historyOptions)).duplicate, 1);
  assert.equal((await svc.accept(heldComment, historyOptions)).queued, 1);
  await svc.importReceipt(jobs.pop().payload.receiptKey);
  assert.equal((await held.reload()).state, 'review'); // The provider still denies access.
  assert.deepEqual(held.event, stored);
  denied = false;
  const before = jobs.length;
  const attempts = await Promise.all([retry(41), retry(41)]);
  assert.deepEqual(attempts.sort(), [false, true]);
  assert.equal(jobs.length, before + 1);
  await svc.importReceipt(jobs.pop().payload.receiptKey);
  assert.equal((await held.reload()).state, 'persisted');
  assert.equal(held.event.source, 'new');
  assert.equal((await svc.accept(heldComment, historyOptions)).duplicate, 1);
  assert.equal(await retry(41), false);
  assert.equal(await db.Message.count({ where: { 'metadata.providerId': stored.eventId } }), 1);
  await webhook(comment('994'));
  const pendingComment = await db.Message.findOne({ where: { 'metadata.providerId': '994' } });
  proof = null;
  unknown = true;
  assert.equal((await reply({ commentMessageId: pendingComment.id })).outcome, 'unknown');
  await pendingComment.reload();
  assert.deepEqual((await svc.availability(thread, [pendingComment])).comments[pendingComment.id], {
    available: false, reason: 'reconciliation_required',
  });
  proof = { available: false, reason: 'provider_rejected' };
  assert.deepEqual((await svc.availability(thread, [pendingComment])).comments[pendingComment.id], {
    available: true, reason: null,
  });
  await require('./fixtures/quickchat_instagram_withdrawal.fixture')({ db, svc, at, dm, webhook, resolve, jobs, dispatched, packets, accounts,
    setDenied: value => { denied = value; }, setRedisDown: value => { redisUnavailable = value; } });
  assert(packets.length >= 8);
  report.checks.push(
    'Firma, migración repetible, duplicados, privado concurrente, DM y continuidad, dos sedes, Messenger, revisión, ventanas, revocación, conciliación sin reenvío, eco, histórico y recuperación concurrente de un webhook retenido por permisos.',
  );
}).catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
