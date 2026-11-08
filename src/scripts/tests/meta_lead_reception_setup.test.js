'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, command, safe } = require('../../services/metaLeadReceptionSetup.service');
const { createRouter } = require('../../routes/metaLeadReceptionSetup.routes');
const C = require('../../services/metaMarketingEnrollment.contract');
const UUID = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const HASH = 'a'.repeat(64);
function fixture({ actualAuthorization = false } = {}) {
  const input = { scopeKey: 'clinic:11', actorId: 22, sessionRef: UUID(2), sessionExpiresAt: new Date('2030-01-01') };
  const assets = C.assets([{ kind: 'ad_account', id: '101', assetRef: 'meta-ad_account:101', parentPageId: null },
    { kind: 'facebook_page', id: '201', assetRef: 'meta-facebook_page:201', parentPageId: null }]);
  const now = new Date('2026-01-01');
  const state = { allowed: true, verified: true, structural: 1, subscription: false, revision: HASH, reads: [], prepares: [], authorizeCalls: 0,
    state: 'active', sessionAllowed: true, onRead: null, route: null, scopes: 'clinic:11', enrollmentId: UUID(1),
    mappings: [{ id: 31, assetType: 'ad_account', metaAssetId: '101', metaConnectionId: 41, assignmentScope: 'clinic', clinicaId: 11, grupoClinicaId: null, isActive: true },
      { id: 32, assetType: 'facebook_page', metaAssetId: '201', metaConnectionId: 41, assignmentScope: 'clinic', clinicaId: 11, grupoClinicaId: null, isActive: true }] };
  state.enrollment = { enrollment_id: UUID(1), flow_id: UUID(2), session_ref: UUID(3), prepare_request_id: UUID(4), activate_request_id: UUID(5), revoke_request_id: UUID(6),
    scope_digest: HASH, flow_digest: HASH, candidate_digest: HASH, assignment_digest: HASH, scope_key: 'clinic:11', actor_user_id: 22,
    meta_connection_id: 41, connection_ref: 'fictitious-connection', meta_user_id: '301', app_id: '401', clinic_ids: '[11]', assets: JSON.stringify(assets),
    mapping_ids: '[31,32]', session_expires_at: now, requested_at: now, updated_at: now, next_attempt_at: now, prepared_at: now, activated_at: now,
    revoked_at: null, attempts: 0, selection_digest: HASH, last_error: null, lease_token: null, lease_until: null };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    sequelize: { transaction: async (_options, fn) => fn(transaction) },
    Clinica: { findAll: async () => [{ id_clinica: 11 }] },
    UsuarioClinica: { findAll: async options => state.allowed && options.where.rol_clinica[require('sequelize').Op.in].includes('agencia') ? [{ id_clinica: 11 }] : [] },
    CampaignWorkspaceSetting: { findOne: async () => ({ preferences: state.registry === undefined ? {} : { meta_lead_routes: state.registry } }) },
    MetaMarketingEnrollmentRequest: { findOne: async options => {
      assert.equal(options.where.scope_key, input.scopeKey);return state.state ? { ...state.enrollment, state: state.state } : null;
    } },
    ClinicMetaAsset: { findAll: async options => {
      assert.deepEqual(options.attributes, ['id', 'assetType', 'metaAssetId', 'metaConnectionId', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'isActive']);
      assert.equal(options.where.clinicaId, 11);assert.equal(options.where.grupoClinicaId, null);assert.equal(options.where.assignmentScope, 'clinic');
      return state.mappings.filter(row => row.assignmentScope === 'clinic' && row.clinicaId === 11 && row.grupoClinicaId === null && row.isActive);
    } },
  };
  const sessions = { verifyReference: async (_input, options) => {
    assert.equal(options.requireEmail, true);
    if (!state.verified) throw Object.assign(Error('email'), { code: 'auth_email_verification_required' });
    if (!state.sessionAllowed) throw Object.assign(Error('auth'), { code: 'auth_invalid' });
  } };
  const authority = () => ({
    page: { id: '201', mappingId: 32, scopeKey: state.scopes, clinicIds: [11], enrollmentId: state.enrollmentId },
    account: { id: '101', mappingId: 31, scopeKey: state.scopes, clinicIds: [11], enrollmentId: state.enrollmentId },
    route: { recipientClinicId: state.route }, fingerprint: String(state.structural),
  });
  const reader = {
    preparePair: async (page, account) => { state.prepares.push([page, account]);return {}; },
    assertPair: async () => authority(),
    read: async (_pair, operation, payload) => {
      state.reads.push({ operation, payload });
      if (state.error) throw state.error;
      if (operation === 'pageEnable') {
        assert.equal(payload.expectedSubscriptionRevision, state.revision);
        if (!state.unconfirmed) { state.subscription = true;state.revision = 'b'.repeat(64); }
      }
      const result = { page: { id: '201', has_lead_access: state.leadAccess !== false },
        subscription: { subscribed: state.subscription, fields: ['feed', 'messages', ...(state.subscription ? ['leadgen'] : [])], revision: state.revision } };
      if (state.onRead) await state.onRead(operation);
      return result;
    },
  };
  const authorize = async received => {
    state.authorizeCalls++;
    assert.equal(received, input);
    if (!state.allowed || received.scopeKey !== 'clinic:11') throw Object.assign(Error('denied'), { code: 'meta_oauth_scope_forbidden', httpStatus: 403 });
    return { clinicIds: [11] };
  };
  const service = createService({ models, sessions, reader, ...(actualAuthorization ? {} : { authorize }), enabled: () => state.enabled !== false });
  return { service, input, state, reader, models, sessions,
    page: async () => (await service.overview(input)).pages[0],
    check: async function () { const page = await this.page();return service.execute(input, 32, { action: 'check', revision: page.revision }); },
    enable: async function () { const checked = await this.check();return service.execute(input, 32,
      { action: 'enable', revision: checked.revision, confirmed: true, expectedSubscriptionRevision: checked.subscriptionRevision }); },
  };
}

test('overview uses existing active enrollment and exact direct-clinic mapping; no provider calls', async () => {
  const f = fixture();const overview = await f.service.overview(f.input);
  assert.equal(overview.pages.length, 1);assert.deepEqual(f.state.prepares, [[32, 31]]);assert.equal(f.state.reads.length, 0);
  assert.deepEqual(Object.keys(overview.pages[0]).sort(), ['accountId', 'pageId', 'pageMappingId', 'revision']);
  for (const change of [f => { f.state.state = null; }, f => { f.state.state = 'revoked';f.state.enrollment.revoked_at = new Date(); },
    f => { f.state.enabled = false; }, f => { f.state.enrollment.assets = JSON.stringify(C.assets([{ kind: 'ad_account', id: '101', assetRef: 'meta-ad_account:101', parentPageId: null }])); }]) {
    const f = fixture();change(f);assert.deepEqual((await f.service.overview(f.input)).pages, []);assert.equal(f.state.reads.length, 0);
  }
});
test('multiple enrolled Ads accounts stay unavailable instead of guessing a pair', async () => {
  const f = fixture();const selected = JSON.parse(f.state.enrollment.assets);
  selected.push({ kind: 'ad_account', id: '102', assetRef: 'meta-ad_account:102', parentPageId: null });
  f.state.enrollment.assets = JSON.stringify(C.assets(selected));assert.deepEqual((await f.service.overview(f.input)).pages, []);
  assert.equal(f.state.prepares.length, 0);assert.equal(f.state.reads.length, 0);
});
test('an explicit empty or administrative routing registry cannot be enabled through the ordinary direct-clinic path', async () => {
  for (const registry of [[], [{ pageAssetRef: 'meta-facebook_page:201', adAccountAssetRef: 'meta-ad_account:101', recipientClinicId: 11 }]]) {
    const f = fixture();f.state.registry = registry;assert.deepEqual((await f.service.overview(f.input)).pages, []);
    assert.equal(f.state.prepares.length, 0);assert.equal(f.state.reads.length, 0);
  }
});
test('managed session, email and marketing WRITE admit agencia without Settings edit', async () => {
  const f = fixture({ actualAuthorization: true });assert.equal((await f.service.overview(f.input)).pages.length, 1);
  for (const change of [f => { f.state.allowed = false; }, f => { f.state.verified = false; }, f => { f.state.sessionAllowed = false; }]) {
    const f = fixture({ actualAuthorization: true });change(f);await assert.rejects(f.service.overview(f.input));assert.equal(f.state.prepares.length, 0);
  }
});
test('invalid commands, foreign mapping, inherited scopes, changed enrollment and recipient routes deny before provider', async () => {
  const f = fixture();const page = await f.page();
  for (const patch of [{ token: 'PRIVATE' }, { endpoint: '/me' }, { action: 'enable' }, { action: 'enable', confirmed: 'true', expectedSubscriptionRevision: HASH },
    { action: 'check', expectedSubscriptionRevision: HASH }, { revision: [HASH] }, { action: 'enable', confirmed: true, expectedSubscriptionRevision: [HASH] }, { revision: 'stale' }, { actorId: 1 }]) {
    assert.throws(() => command({ action: 'check', revision: page.revision, ...patch }), /meta_lead_setup_invalid/);
  }
  await assert.rejects(f.service.execute(f.input, 999, { action: 'check', revision: page.revision }));
  for (const change of [f => { f.state.allowed = false; }, f => { f.input.scopeKey = 'group:11'; }, f => { f.state.scopes = 'clinic:12'; },
    f => { f.state.enrollmentId = UUID(99); }, f => { f.state.route = 12; }, f => { f.state.mappings[1].assignmentScope = 'group'; }]) {
    const f = fixture();change(f);await assert.rejects(f.service.overview(f.input));assert.equal(f.state.reads.length, 0);
  }
  assert.equal(f.state.reads.length, 0);
});
test('manual check and explicit enable use only Page operations and subscription CAS, then confirm', async () => {
  const f = fixture();const result = await f.enable();assert.equal(result.state, 'verified');
  assert.deepEqual(f.state.reads.map(call => call.operation), ['pageStatus', 'pageStatus', 'pageEnable', 'pageStatus']);
  assert.deepEqual(f.state.reads[2].payload, { expectedSubscriptionRevision: HASH });
  assert(!JSON.stringify(result).includes('live'));assert(!JSON.stringify(result).includes('credentials'));
});
test('stale binding or subscription revision, missing lead access and unconfirmed POST never assert readiness', async () => {
  const f = fixture();const checked = await f.check();f.state.structural++;
  await assert.rejects(f.service.execute(f.input, 32, { action: 'enable', revision: checked.revision, confirmed: true, expectedSubscriptionRevision: HASH }), /conflict/);
  for (const change of [f => { f.state.revision = 'c'.repeat(64); }, f => { f.state.leadAccess = false; }]) {
    const f = fixture();const checked = await f.check();change(f);
    try { const result = await f.service.execute(f.input, 32, { action: 'enable', revision: checked.revision, confirmed: true, expectedSubscriptionRevision: checked.subscriptionRevision });
      assert.equal(result.state, 'access_required'); } catch (error) { assert.equal(error.code, 'meta_lead_setup_conflict'); }
    assert(!f.state.reads.some(call => call.operation === 'pageEnable'));
  }
  const unconfirmed = fixture();unconfirmed.state.unconfirmed = true;await assert.rejects(unconfirmed.enable(), /unconfirmed/);
});
test('revoked actor or changed enrollment during provider I/O prevents enable and success', async () => {
  for (const change of [f => { f.state.allowed = false; }, f => { f.state.structural++; }, f => { f.state.state = null; }]) {
    const f = fixture();const checked = await f.check();f.state.onRead = () => change(f);
    await assert.rejects(f.service.execute(f.input, 32, { action: 'enable', revision: checked.revision, confirmed: true, expectedSubscriptionRevision: HASH }));
    assert.equal(f.state.reads.filter(call => call.operation === 'pageEnable').length, 0);
  }
  const f = fixture();const checked = await f.check();f.state.onRead = operation => { if (operation === 'pageEnable') f.state.allowed = false; };
  await assert.rejects(f.service.execute(f.input, 32, { action: 'enable', revision: checked.revision, confirmed: true, expectedSubscriptionRevision: HASH }));
  assert.equal(f.state.reads.at(-1).operation, 'pageEnable');
});
test('only reader-issued cooldown creates WAIT and does not schedule or automatically retry', async () => {
  const f = fixture();const page = await f.page();
  const { createMetaMarketingLeadReader } = require('../../services/metaMarketingLeadReader.service');
  const scopeState = { kind: 'facebook_page', appId: '401', subjectId: '301', enrollmentHash: HASH, scopeKey: 'clinic:11', connectionRef: 'fixture', connectionId: 41,
    tenantRef: 'clinic:11', clinicIds: [11], id: '201', assetRef: 'meta-facebook_page:201' };
  const closed = createMetaMarketingLeadReader({ enabled: () => true,
    scope: { prepare: async id => id === 32 ? scopeState : { ...scopeState, kind: 'ad_account', id: '101', assetRef: 'meta-ad_account:101' }, assertContext: async value => value },
    client: { execute: async () => { throw Object.assign(Error('WAIT'), { code: 'rate_limited', retryAfterMs: 60000 }); } } });
  const pair = await closed.preparePair(32, 31);
  try { await closed.read(pair, 'pageStatus', {}); } catch (error) { f.state.error = error; }
  const waiting = await f.service.execute(f.input, 32, { action: 'check', revision: page.revision });
  assert.equal(waiting.status, 'waiting');assert.equal(waiting.reason, 'meta_broker_cooldown');assert.equal(f.state.reads.length, 1);
  f.state.error = Object.assign(Error('forged'), { code: 'rate_limited', retryAfterMs: 60000 });
  await assert.rejects(f.service.execute(f.input, 32, { action: 'check', revision: page.revision }));
  assert.equal(safe({ message: 'PRIVATE', code: 'arbitrary' }), 'meta_lead_setup_unavailable');
});

test('fresh authorization precedes all enrollment inspection and is repeated even when the latest row is absent', async () => {
  const denied = fixture({ actualAuthorization: true });let enrollmentReads = 0;
  denied.models.MetaMarketingEnrollmentRequest.findOne = async () => { enrollmentReads++;return null; };
  denied.state.allowed = false;await assert.rejects(denied.service.overview(denied.input), /meta_oauth_scope_forbidden/);
  assert.equal(enrollmentReads, 0);assert.equal(denied.state.prepares.length, 0);
  for (const latest of [null, 'active']) {
    const f = fixture({ actualAuthorization: true });let transactions = 0;let sessionChecks = 0;
    const transact = f.models.sequelize.transaction, verify = f.sessions.verifyReference;
    f.sessions.verifyReference = async (...args) => { sessionChecks++;return verify(...args); };
    f.models.sequelize.transaction = async (...args) => {
      const result = await transact(...args);
      if (++transactions === 1) { f.state.allowed = false;f.state.state = latest; }
      return result;
    };
    await assert.rejects(f.service.overview(f.input), /meta_oauth_scope_forbidden/);
    assert.equal(sessionChecks, 2);assert.equal(f.state.prepares.length, 0);assert.equal(f.state.reads.length, 0);
  }
});
test('the locked main transaction reads the current latest enrollment instead of a preauthorization snapshot', async () => {
  const f = fixture();const prior = await f.page();let transactions = 0;
  const transact = f.models.sequelize.transaction;
  f.models.sequelize.transaction = async (...args) => {
    const result = await transact(...args);
    if (++transactions === 1) { f.state.enrollment.enrollment_id = UUID(99);f.state.enrollmentId = UUID(99); }
    return result;
  };
  const latest = await f.page();assert.notEqual(latest.revision, prior.revision);assert.equal(f.state.reads.length, 0);
});

// A deterministic lock manager models real row ownership and wait cycles, not
// an expected call list. The competing task below runs the production Lead
// reader, scope repository and enrollment committed path until its clinic read.
function lockScheduler() {
  const owners = new Map(), held = new Map(), waitingFor = new Map(), queues = new Map();
  const state = { deadlocks: 0, trace: [] };
  const acquire = async (transaction, resource) => {
    assert(transaction?.LOCK?.UPDATE);const owner = owners.get(resource);
    state.trace.push({ transaction: transaction.label, resource, waiting: Boolean(owner && owner !== transaction) });
    if (owner === transaction) return;
    if (!owner) { owners.set(resource, transaction);if (!held.has(transaction)) held.set(transaction, new Set());held.get(transaction).add(resource);return; }
    waitingFor.set(transaction, owner);
    for (let cursor = owner; cursor; cursor = waitingFor.get(cursor)) {
      if (cursor === transaction) { waitingFor.delete(transaction);state.deadlocks++;throw Error('DETERMINISTIC_ROW_DEADLOCK'); }
    }
    await new Promise(resolve => { if (!queues.has(resource)) queues.set(resource, []);queues.get(resource).push({ transaction, resolve }); });
  };
  const release = transaction => {
    for (const resource of held.get(transaction) || []) {
      const next = queues.get(resource)?.shift();
      if (next) { owners.set(resource, next.transaction);waitingFor.delete(next.transaction);if (!held.has(next.transaction)) held.set(next.transaction, new Set());held.get(next.transaction).add(resource);next.resolve(); }
      else owners.delete(resource);
    }
    held.delete(transaction);waitingFor.delete(transaction);transaction.finished = true;
  };
  return { state, acquire, async run(label, work) { const transaction = { label, LOCK: { UPDATE: 'UPDATE' } };try { return await work(transaction); } finally { release(transaction); } } };
}
const barrier = () => { let resolve;const promise = new Promise(done => { resolve = done; });return { promise, resolve }; };
test('concurrent setup authorization and the actual inbound reader enrollment commit avoid the former clinic/enrollment deadlock', async () => {
  const f = fixture({ actualAuthorization: true }), locks = lockScheduler();
  const setupClinic = barrier(), readerEnrollment = barrier(), readerClinicRequest = barrier(), releaseSetup = barrier();
  let setupTransactions = 0, readerCommitClinicReads = 0;
  const previousFlags = { leads: process.env.META_MARKETING_LEADGEN_ENABLED, broker: process.env.META_MARKETING_BROKER_ENABLED };
  process.env.META_MARKETING_LEADGEN_ENABLED = 'true';process.env.META_MARKETING_BROKER_ENABLED = 'true';
  const flow = { flow_id: UUID(2), state: 'staged', scope_key: 'clinic:11' };
  f.state.enrollment.flow_digest = C.sourceDigest(flow);
  f.models.PlatformAuditEvent = { sequelize: {} };
  f.models.sequelize.transaction = (_options, work) => locks.run('setup-' + (++setupTransactions), work);
  f.models.Clinica.findAll = async options => {
    assert.equal(options.lock, options.transaction.LOCK.UPDATE);
    if (options.transaction.label === 'reader') { readerCommitClinicReads++;readerClinicRequest.resolve(); }
    await locks.acquire(options.transaction, 'clinic:11');
    if (options.transaction.label === 'setup-1') { setupClinic.resolve();await releaseSetup.promise; }
    // End the competing reader's validation immediately after the real
    // committed -> revalidateStructure path acquired its clinic lock. No
    // unrelated provider, credential or enrollment fixture is needed.
    return options.transaction.label === 'reader' ? [] : [{ id_clinica: 11 }];
  };
  f.models.MetaMarketingEnrollmentRequest.findOne = async options => {
    assert.equal(options.where.scope_key, 'clinic:11');assert.equal(options.lock, options.transaction.LOCK.UPDATE);
    await locks.acquire(options.transaction, 'enrollment:' + UUID(1));return { ...f.state.enrollment, state: f.state.state };
  };
  f.models.MetaMarketingEnrollmentRequest.findByPk = async (id, options) => {
    assert.equal(id, UUID(1));assert.equal(options.lock, options.transaction.LOCK.UPDATE);
    await locks.acquire(options.transaction, 'enrollment:' + id);
    if (options.transaction.label === 'reader') readerEnrollment.resolve();
    return { ...f.state.enrollment, state: f.state.state };
  };
  f.models.MetaMarketingOAuthRequest = { findByPk: async () => flow };
  f.models.MetaMarketingBrokerRevocation = { findAll: async () => [] };
  f.models.MetaMarketingBrokerBinding = { findAll: async options => {
    if (options.attributes.join(',') === 'enrollment_id') return [{ enrollment_id: UUID(1) }];
    const row = f.state.mappings.find(row => row.id === options.where.mapping_id);
    return [{ mapping_id: row.id, enrollment_id: UUID(1), asset_ref: 'meta-' + row.assetType + ':' + row.metaAssetId,
      meta_connection_id: 41, meta_user_id: '301', app_id: '401', connection_ref: 'fixture', scope_key: 'clinic:11',
      tenant_clinic_id: 11, parent_page_id: null, state: 'active' }];
  } };
  f.models.ClinicMetaAsset.findByPk = async id => ({ ...f.state.mappings.find(row => row.id === id), credentials_absent: 1 });
  let setup, competing;
  try {
    setup = f.service.overview(f.input);await setupClinic.promise;
    // This is the real forModels transactionStates implementation: it locks
    // enrollment before BrokerScope.inspectEnrollment/Binding.committed reach
    // OAuthScope.revalidateStructure's clinic query. No provider call occurs.
    const inbound = require('../../services/metaMarketingLeadReader.service').forModels(f.models);
    competing = locks.run('reader', transaction => inbound.preparePair(32, 31, { transaction }));
    const competingResult = competing.then(() => null, error => error);
    await readerEnrollment.promise;await readerClinicRequest.promise;releaseSetup.resolve();
    const [overview, readerError] = await Promise.all([setup, competingResult]);
    assert.equal(overview.pages.length, 1);assert.equal(readerError?.code, 'meta_broker_binding_invalid');
    assert.equal(readerCommitClinicReads, 1);assert.equal(locks.state.deadlocks, 0);assert.equal(f.state.reads.length, 0);
    assert.equal(setupTransactions, 2);
  } finally {
    releaseSetup.resolve();await Promise.allSettled([setup, competing].filter(Boolean));
    for (const [key, value] of Object.entries({ META_MARKETING_LEADGEN_ENABLED: previousFlags.leads, META_MARKETING_BROKER_ENABLED: previousFlags.broker })) {
      if (value === undefined) delete process.env[key];else process.env[key] = value;
    }
  }
});

test('route accepts only managed direct-clinic requests and closed actions; errors stay private', async () => {
  const calls = [];
  const router = createRouter({ sessions: { verify: async () => ({ sessionVersion: 1, jti: UUID(1), userId: 22, exp: Math.floor(Date.now() / 1000) + 1000 }) },
    service: { overview: async input => { calls.push(input);return { enabled: true, pages: [] }; }, execute: async () => { throw Error('PRIVATE_SQL'); } } });
  const invoke = (method, query, body) => new Promise((resolve, reject) => {
    const req = { method, url: method === 'GET' ? '/lead-reception' : '/lead-reception/pages/32', query, body, headers: { authorization: 'Bearer fictitious' } };
    const res = { headers: {}, set(key, value) { this.headers[key] = value;return this; }, status(value) { this.statusCode = value;return this; },
      json(value) { resolve({ status: this.statusCode || 200, value, headers: this.headers }); } };
    router.handle(req, res, reject);
  });
  assert.equal((await invoke('GET', { assignment_scope: 'clinic', clinic_id: '11' })).status, 200);assert.equal(calls[0].scopeKey, 'clinic:11');
  for (const query of [{ assignment_scope: 'group', group_id: '11' }, { assignment_scope: 'clinic', clinic_id: '11', token: 'PRIVATE' }, { assignment_scope: 'clinic', clinic_id: ['11'] }]) {
    assert.equal((await invoke('GET', query)).status, 400);
  }
  assert.equal(calls.length, 1);
  const error = await invoke('POST', { assignment_scope: 'clinic', clinic_id: '11' }, {});
  assert.equal(error.status, 503);assert.equal(error.value.error, 'meta_lead_setup_unavailable');assert.equal(error.headers['Cache-Control'], 'private, no-store');
});
