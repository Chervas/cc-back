'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { DataTypes: D, Op } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async ({ sql, models, report, registerOwnedLoopbackServer }) => {
  const migration = require('../../../migrations/20260919200000-create-business-profile-mutation-journal');
  await migration.up(sql.getQueryInterface()); await migration.up(sql.getQueryInterface());
  const coordinationMigration = require('../../../migrations/20260919210000-create-business-profile-cache-coordination');
  await coordinationMigration.up(sql.getQueryInterface()); await coordinationMigration.up(sql.getQueryInterface());
  const observed = await require('../../lib/securitySchemaContract').snapshot(async (query, replacements) =>
    (await sql.query(query, { replacements, logging: false }))[0]);
  const schemaTables = {};
  for (const name of ['BusinessProfileMutations', 'BusinessProfileMutationLocks', 'BusinessProfileCacheStates']) {
    const table = observed.tables.find(row => row.TABLE_NAME === name);
    const indexes = observed.indexes.filter(row => row.TABLE_NAME === name);
    schemaTables[name] = { ENGINE: table.ENGINE, TABLE_COLLATION: table.TABLE_COLLATION,
      columns: observed.columns.filter(row => row.TABLE_NAME === name).map(({ TABLE_NAME, ...row }) => row),
      indexes: [...new Set(indexes.map(row => row.INDEX_NAME))].map(index => ({ name: index,
        columns: indexes.filter(row => row.INDEX_NAME === index).map(({ TABLE_NAME, ...row }) => row) })),
      checks: observed.checks.filter(row => row.TABLE_NAME === name).map(({ TABLE_NAME, ...row }) => row),
      foreignKeys: observed.foreignKeys.filter(row => row.TABLE_NAME === name).map(({ TABLE_NAME, ...row }) => row) };
  }
  require('node:fs').writeFileSync(require('node:path').join(report.root, 'gbp-mutation-schema.json'),
    JSON.stringify(schemaTables, null, 2), { mode: 0o600, flag: 'wx' });
  for (const [name, file] of [['BusinessProfileMutation', 'businessprofilemutation'], ['BusinessProfileMutationLock', 'businessprofilemutationlock'],
    ['BusinessProfileCacheState', 'businessprofilecachestate'], ['PlatformAuditEvent', 'platformauditevent']]) models[name] = require('../../../models/' + file)(sql, D);
  await models.PlatformAuditEvent.sync();
  const Session = sql.define('QaGbpSession', { id: { type: D.UUID, primaryKey: true }, user_id: D.INTEGER, expires_at: D.DATE(3), active: D.BOOLEAN }, { timestamps: false });
  const Cache = sql.define('QaGbpCache', { id: { type: D.INTEGER, primaryKey: true }, value: D.JSON, writes: D.INTEGER }, { timestamps: false });
  await Session.sync(); await Cache.sync(); await Cache.create({ id: 1, value: {}, writes: 0 });
  let at = Date.now(), allowed = true, enabled = true, scopeChanged = false, automationAllowed = true;
  let beforeRemote, afterRemote, remoteFailure = false, writes = 0, providerCalls = [], applyCalls = 0;
  const actor = { type: 'user', userId: 91002, sessionRef: randomUUID(), expiresAt: at + 3600000 };
  await Session.create({ id: actor.sessionRef, user_id: actor.userId, expires_at: new Date(actor.expiresAt), active: true });
  const sessions = { async verifyReference(value, { transaction } = {}) {
    const row = await Session.findByPk(value.sessionRef, { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!row?.active || row.user_id !== value.userId || new Date(row.expires_at).getTime() !== +value.expiresAt || +row.expires_at <= at) throw Object.assign(Error('PRIVATE_SESSION'), { status: 401 });
  } };
  const cleanups = [], f = require('../../../services/integrations-broker/test/helpers').fixture({ after: fn => cleanups.push(fn) });
  const C = require('../../../services/integrations-broker/src/google-business-profile-write-contract');
  const { createBusinessProfileWrites } = require('../../../services/integrations-broker/src/google-business-profile-writes');
  const { Broker } = require('../../../services/integrations-broker/src/broker');
  const { fail } = require('../../../services/integrations-broker/src/errors');
  const location = { id: 51, clinica_id: 71, google_connection_id: 81, location_id: 'locations/456', is_active: true,
    broker_read_connection_ref: 'connection:test', broker_read_asset_ref: 'gbp:123:456' };
  f.policy.maxBacklog = 10000; f.policy.principals[0].maxPerMinute = 600;
  f.policy.connections[0] = { ...f.policy.connections[0], provider: C.PROVIDER, secretArn: 'qa-google', clientSecretArn: 'qa-client',
    googleBusinessProfileWrites: { locations: [{ assetRef: 'gbp:123:456', tenantRef: 'clinic:71',
      allowReviewReplies: true, allowPhotos: true, allowSpecialHours: true }] } };
  f.policy.grants[0] = { ...f.policy.grants[0], tenantRef: 'clinic:71', assetRef: 'gbp:123:456', operations: Object.values(C.OPERATIONS) };
  const http = async request => {
    assert.equal(request.token.toString(), 'FICTITIOUS_GBP_TOKEN');
    if (!request.businessProfileMutation) return { name: 'locations/456', regularHours: { periods: [{ openDay: 'MONDAY' }] } };
    writes++; providerCalls.push(request.businessProfileMutation); if (remoteFailure) fail('provider_timeout');
    if (request.businessProfileMutation === 'replyUpdate') return { comment: request.json.comment, updateTime: new Date(at).toISOString() };
    if (request.businessProfileMutation === 'replyDelete') return {};
    if (request.businessProfileMutation === 'hours') return request.json;
    return { name: 'accounts/123/locations/456/media/' + writes, mediaFormat: 'PHOTO' };
  };
  const makeRemote = () => new Broker({ store: f.store, policy: f.policy, now: () => at,
    secrets: { invalidate() {}, withSecret: (_binding, work) => work(Buffer.from('FICTITIOUS_GBP_TOKEN')) },
    operations: createBusinessProfileWrites({ store: f.store, http, now: () => at }).operations });
  let remote = makeRemote();
  const clientCalls = [];
  const writerClient = { async execute(command) {
    command = { requestId: randomUUID(), ...command };
    const row = await models.BusinessProfileMutation.findByPk(command.payload.operationId);
    assert(row, 'SQL admission must precede transport');
    assert.equal(await models.PlatformAuditEvent.count({ where: { correlation_id: row.operation_id, stage: 'attempted' } }), 1);
    clientCalls.push(command.operation); await beforeRemote?.(command);
    const signed = require('../../../services/integrations-broker/src/auth').signRequest(command,
      { keyId: 'qa-key', privateKey: f.keys.privateKey, audience: f.policy.audience, now: at });
    const response = await remote.execute(signed.raw, signed.headers); await afterRemote?.(command, response); return response;
  } };
  const broker = require('../../services/businessProfileBroker.service').createBusinessProfileBroker({ client: {}, writerClient,
    enabled: () => enabled, writesEnabled: () => enabled, loadLocation: async () => scopeChanged ? { ...location, clinica_id: 999 } : location,
    loadManagedBinding: async () => ({ external_location_id: '456', connection_ref: 'connection:test', asset_ref: 'gbp:123:456', clinica_id: 71, google_connection_id: 81 }) });
  const { createBusinessProfileMutationJournal } = require('../../services/businessProfileMutationJournal.service');
  const make = audit => createBusinessProfileMutationJournal({ models, sessions, audit, now: () => at, enabled: () => enabled, namespace: () => 'staging' });
  let journal = make();
  const context = { actor, runtimeNamespace: 'staging', clinicId: 71, clinicIds: [71], location, broker,
    brokerContext: await broker.prepare(location, () => { throw Error('LEGACY_FORBIDDEN'); }, new Map()),
    beforeExecute: async () => allowed, verifyAutomation: async () => automationAllowed,
    applyResult: async ({ row, result, transaction }) => {
      assert(transaction); applyCalls++;
      const cache = await Cache.findByPk(1, { transaction, lock: transaction.LOCK.UPDATE });
      await cache.update({ value: { kind: row.kind, result, local: row.local_input }, writes: cache.writes + 1 }, { transaction });
    } };
  const reply = (comment = 'Gracias 🌻') => ({ operationId: randomUUID(), reviewId: 'review_1', comment });
  const local = { reviewId: 10 };
  const run = (input, ctx = context, kind = 'replyUpdate', data = local) => journal.execute(ctx, kind, input, data);
  const recover = (input, ctx = context) => journal.recover(ctx, input.operationId);
  try {
    const first = reply(); const result = await run(first); assert.equal(result.state, 'applied'); assert.equal(writes, 1);
    assert.equal((await Cache.findByPk(1)).value.result.comment, first.comment);
    journal = make(); remote = makeRemote();
    const calls = clientCalls.length; assert.equal((await run(first)).state, 'applied'); assert.equal((await recover(first)).state, 'applied');
    assert.equal(clientCalls.length, calls); assert.equal(applyCalls, 1);
    await assert.rejects(run({ ...first, comment: 'changed' }), { code: 'business_profile_mutation_conflict' });
    await assert.rejects(run(first, context, 'replyUpdate', { reviewId: 99 }), { code: 'business_profile_mutation_conflict' });
    const saved = await models.BusinessProfileMutation.findByPk(first.operationId);
    assert(saved.input_digest && saved.scope_digest); assert.equal(saved.state, 'applied');
    assert.equal(await models.BusinessProfileMutationLock.count(), 0);
    await assert.rejects(migration.down(sql.getQueryInterface()), /Preserve Business Profile/);
    report.checks.push('migration repeatable, Unicode preserved, intent/body immutable; completed SQL receipt survives reconstruction without transport or cache replay; down refuses history');

    const lost = reply('ACK perdido'); afterRemote = command => { if (command.operation !== C.OPERATIONS.status) throw Object.assign(Error('PRIVATE'), { code: 'broker_unavailable' }); };
    await assert.rejects(run(lost), { code: 'broker_unavailable' }); afterRemote = null;
    const before = writes, cacheBefore = (await Cache.findByPk(1)).writes;
    assert.equal((await run(lost)).state, 'unknown'); assert.equal(writes, before);
    await assert.rejects(run(reply()), { code: 'business_profile_mutation_busy' });
    assert.equal(writes, before); assert.equal((await Cache.findByPk(1)).writes, cacheBefore);
    const renewed = { ...context, actor: { ...actor, sessionRef: randomUUID(), expiresAt: at + 7200000 } };
    await Session.create({ id: renewed.actor.sessionRef, user_id: actor.userId, expires_at: new Date(renewed.actor.expiresAt), active: true });
    journal = make(); remote = makeRemote();
    assert.equal((await recover(lost, renewed)).state, 'applied'); assert.equal(writes, before);
    assert.equal((await Cache.findByPk(1)).writes, cacheBefore + 1);
    const next = reply('Cambio posterior'); await run(next); const latest = (await Cache.findByPk(1)).value;
    await recover(lost, renewed); assert.deepEqual((await Cache.findByPk(1)).value, latest);
    const events = await models.PlatformAuditEvent.findAll({ where: { correlation_id: lost.operationId }, raw: true });
    assert.equal(events.length, 2); const completed = JSON.parse(events.find(row => row.stage === 'completed').body);
    assert.equal(completed.reason, 'mutation_recovered'); assert.equal(completed.sessionRef, renewed.actor.sessionRef);
    assert.equal(completed.initiatorSessionRef, actor.sessionRef);
    report.checks.push('lost broker ACK holds SQL resource lock; new session recovers original audit/cache atomically; old receipt cannot overwrite a newer local change');

    let release, started; const entered = new Promise(resolve => { started = resolve; });
    beforeRemote = command => command.operation === C.OPERATIONS.status ? undefined : new Promise(resolve => { release = resolve; started(); });
    const parallel = reply('Concurrente'), running = run(parallel); await entered;
    assert.equal((await run(parallel)).state, 'unknown');
    assert.equal((await recover(parallel)).state, 'unknown');
    // The recovery hook must not wait for the mutation hook itself.
    report.checks.push('in-flight intent is visible before provider dispatch');
    beforeRemote = null; release(); await running;

    const originalAppend = require('../../services/platformAudit.repository').createRepository(models.PlatformAuditEvent);
    const failure = reply('Fallo commit'); let failComplete = true;
    journal = make({ ...originalAppend, append: async (event, options) => {
      if (failComplete && event.stage === 'completed') throw Error('PRIVATE_AUDIT_FAILURE');
      return originalAppend.append(event, options);
    } });
    const priorCache = (await Cache.findByPk(1)).value;
    await assert.rejects(run(failure), { code: 'audit_unavailable' });
    assert.deepEqual((await Cache.findByPk(1)).value, priorCache);
    assert.equal((await models.BusinessProfileMutation.findByPk(failure.operationId)).state, 'attempted');
    failComplete = false; const writesBeforeRecovery = writes;
    assert.equal((await recover(failure)).state, 'applied'); assert.equal(writes, writesBeforeRecovery); journal = make();
    report.checks.push('audit completion failure rolls back local cache and receipt together while keeping the resource lock; recovery never resends');

    const sessionLost = reply('Sesión revocada'); afterRemote = async () => { afterRemote = null; await Session.update({ active: false }, { where: { id: actor.sessionRef } }); };
    await assert.rejects(run(sessionLost), { code: 'business_profile_session_required' });
    assert.equal((await recover(sessionLost, renewed)).state, 'applied');
    await Session.update({ active: true }, { where: { id: actor.sessionRef } });
    const scopeLost = reply('Permisos retirados'); afterRemote = () => { afterRemote = null; allowed = false; };
    await assert.rejects(run(scopeLost), { code: 'scope_denied' });
    await assert.rejects(recover(scopeLost), { code: 'scope_denied' }); allowed = true; await recover(scopeLost);
    scopeChanged = true; await assert.rejects(recover(first)); scopeChanged = false;
    enabled = false; await assert.rejects(run(reply()), { code: 'broker_cohort_disabled' }); enabled = true;
    await assert.rejects(recover(first, { ...context, clinicId: 72, clinicIds: [71, 72] }), { code: 'business_profile_mutation_not_found' });
    await assert.rejects(recover(first, { ...context, runtimeNamespace: 'dev' }), { code: 'invalid_request' });
    report.checks.push('session revocation, current ACL, mapping drift, changed clinic/runtime and disabled gate reject response acceptance or lookup without legacy fallback');

    const automated = { ...context, actor: { type: 'automation', userId: actor.userId, executionId: 77, nodeId: 'apply_hours' } };
    const hours = { operationId: randomUUID(), periods: [{ kind: 'closed', startDate: '2026-12-24', endDate: '2026-12-24', openTime: null, closeTime: null }] };
    automationAllowed = false; await assert.rejects(run(hours, automated, 'hours', { plan: {} }), { code: 'business_profile_automation_required' });
    automationAllowed = true;
    afterRemote = command => { if (command.operation === C.OPERATIONS.hours) throw Object.assign(Error(), { code: 'broker_unavailable' }); };
    await assert.rejects(run(hours, automated, 'hours', { plan: {} }), { code: 'broker_unavailable' }); afterRemote = null;
    assert.equal((await recover(hours, renewed)).state, 'applied');
    const auditRows = await models.PlatformAuditEvent.findAll({ where: { correlation_id: hours.operationId }, raw: true });
    assert.equal(JSON.parse(auditRows.find(row => row.stage === 'attempted').body).actor.type, 'job');
    assert.equal(JSON.parse(auditRows.find(row => row.stage === 'completed').body).actor.type, 'user');
    report.checks.push('automation requires an active execution guard; its original owner can recover without impersonating a live job or redispatching hours');

    await require('./fixtures/business_profile_consumers.fixture')({ sql, models, report, writerClient,
      sessions, actor, policy: f.policy, registerOwnedLoopbackServer, resetRemote: () => { remote = makeRemote(); },
      setBefore: fn => { beforeRemote = fn; }, setAfter: fn => { afterRemote = fn; }, writes: () => writes });

    const absent = reply('Todavía no recibido'); beforeRemote = command => { if (command.operation !== C.OPERATIONS.status) throw Object.assign(Error(), { code: 'broker_unavailable' }); };
    await assert.rejects(run(absent), { code: 'broker_unavailable' }); beforeRemote = null;
    assert.equal((await recover(absent)).state, 'unknown'); await assert.rejects(run(reply()), { code: 'business_profile_mutation_busy' });
    const unknownPhoto = { operationId: randomUUID(), sourceUrl: C.PUBLIC_ORIGIN + '/marketing/clinic-71/2026/09/00000000-0000-4000-8000-000000000001.jpg', category: 'ADDITIONAL', description: null };
    remoteFailure = true; await assert.rejects(run(unknownPhoto, context, 'photo', { publicMediaAssetId: 123 }), { code: 'provider_timeout' }); remoteFailure = false;
    assert.equal((await recover(unknownPhoto)).state, 'unknown');
    await assert.rejects(run({ ...unknownPhoto, operationId: randomUUID() }, context, 'photo', { publicMediaAssetId: 123 }), { code: 'business_profile_mutation_busy' });
    await assert.rejects(coordinationMigration.up(sql.getQueryInterface()), /Reconcile pending Business Profile/);
    report.checks.push('broker not_found and provider timeout remain uncertain, preserving locks without automatic replay or false failed/success status');

    const packed = require('../../../services/platform-audit/src/event');
    const rows = await models.PlatformAuditEvent.findAll({ raw: true });
    for (const row of rows) { const event = packed.unpack(row).event; assert.equal(event.version, 25); assert(!row.body.includes('Gracias')); assert(!row.body.includes('FICTITIOUS_GBP_TOKEN')); assert(!row.body.includes('sourceUrl')); }
    const [plans] = await sql.query("EXPLAIN SELECT operation_id FROM BusinessProfileMutationLocks WHERE operation_id = ?", { replacements: [absent.operationId] });
    assert.equal(plans[0].key, 'cc_gbp_mutation_lock_owner');
    const [statusPlan] = await sql.query('EXPLAIN SELECT * FROM BusinessProfileMutations WHERE operation_id = ?', { replacements: [first.operationId] });
    assert.equal(statusPlan[0].key, 'PRIMARY');
    report.checks.push('v25 audit has bounded metadata, no comments/URLs/secrets; receipt and lock-owner queries use indexes on MySQL');
    report.providerMutations = writes; report.clientCalls = clientCalls.length; report.auditEvents = rows.length;
  } finally { for (const close of cleanups.reverse()) await close(); }
}).catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
