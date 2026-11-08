'use strict';

// Closed row-lock fixture: the competing task runs the production Lead reader,
// BrokerScope and EnrollmentBinding through OAuthScope's clinic query. We stop
// there deliberately, before unrelated credential validation or any transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const modelFile = require.resolve('../../../models');
require.cache[modelFile] = { id: modelFile, filename: modelFile, loaded: true,
  exports: new Proxy({}, { get() { throw Error('REAL_MODELS_FORBIDDEN_IN_ADMISSION_FIXTURE'); } }) };
const C = require('../../services/metaMarketingEnrollment.contract');
const UUID = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const HASH = 'a'.repeat(64);
const barrier = () => { let resolve;const promise = new Promise(done => { resolve = done; });return { promise, resolve }; };

function lockScheduler() {
  const owners = new Map(), held = new Map(), waitingFor = new Map(), queues = new Map();
  const state = { deadlocks: 0, trace: [] };
  const acquire = async (transaction, resource) => {
    assert(transaction?.LOCK?.UPDATE);assert(!transaction.finished);
    const owner = owners.get(resource);
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

function fixture(family, group = null) {
  const scopeKey = group ? 'group:' + group : 'clinic:11', clinicIds = group === 28 ? [1, 70] : group === 29 ? [66, 72] : [11];
  const now = new Date('2026-01-01'), input = { scopeKey, actorId: 22, sessionRef: UUID(7), sessionExpiresAt: new Date('2030-01-01') };
  const assets = C.assets([{ kind: 'ad_account', id: '101', assetRef: 'meta-ad_account:101', parentPageId: null },
    { kind: 'facebook_page', id: '201', assetRef: 'meta-facebook_page:201', parentPageId: null }]);
  const flow = { flow_id: UUID(2), state: 'staged', scope_key: scopeKey, app_id: '401' };
  const enrollment = { enrollment_id: UUID(1), flow_id: UUID(2), session_ref: UUID(3), prepare_request_id: UUID(4), activate_request_id: UUID(5), revoke_request_id: UUID(6),
    scope_digest: HASH, flow_digest: C.sourceDigest(flow), candidate_digest: HASH, assignment_digest: HASH, scope_key: scopeKey, actor_user_id: 22,
    meta_connection_id: 41, connection_ref: 'fictitious-connection', meta_user_id: '301', app_id: '401', clinic_ids: JSON.stringify(clinicIds), assets: JSON.stringify(assets),
    mapping_ids: '[31,32]', session_expires_at: now, requested_at: now, updated_at: now, next_attempt_at: now, prepared_at: now, activated_at: now,
    revoked_at: null, attempts: 0, selection_digest: HASH, last_error: null, lease_token: null, lease_until: null, state: 'active' };
  const mappings = [{ id: 31, assetType: 'ad_account', metaAssetId: '101' }, { id: 32, assetType: 'facebook_page', metaAssetId: '201' }]
    .map(row => ({ ...row, metaConnectionId: 41, assignmentScope: group ? 'group' : 'clinic', clinicaId: group ? null : 11, grupoClinicaId: group, isActive: true, credentials_absent: 1 }));
  const locks = lockScheduler(), state = { allowed: true, verified: true, sessionAllowed: true, enrollment, transactions: 0, sessions: 0,
    enrollmentReads: 0, flowReads: 0, providerCalls: 0, writes: 0, clinicReads: new Map(), afterPreauthorization: null, clinicHook: null, enrollmentHook: null,
    stopRecoveryEnrollment: false, recoveryEnrollmentAttempts: 0, maximumHumanClinicReads: 2, auditBoundary: 0, references: [] };
  const models = {
    sequelize: { transaction: async (_options, work) => {
      const n = ++state.transactions, result = await locks.run('human-' + n, work);
      if (n === 1 && state.afterPreauthorization) await state.afterPreauthorization();return result;
    } },
    Clinica: { findAll: async options => {
      const transaction = options.transaction;assert.equal(options.lock, transaction.LOCK.UPDATE);
      const n = (state.clinicReads.get(transaction.label) || 0) + 1;state.clinicReads.set(transaction.label, n);
      if (state.clinicHook) await state.clinicHook(transaction, 'before', n);
      await locks.acquire(transaction, 'clinics:' + scopeKey);
      if (state.clinicHook) await state.clinicHook(transaction, 'after', n);
      // The first main query is fresh human authorization; the second is the
      // real Binding.committed structural guard. End validation only there.
      return transaction.label === 'reader' || transaction.label !== 'human-1' && n > state.maximumHumanClinicReads ? [] : clinicIds.map(id_clinica => ({ id_clinica, grupoClinicaId: group }));
    } },
    UsuarioClinica: { findAll: async options => state.allowed && options.where.rol_clinica[require('sequelize').Op.in].includes('agencia') ? clinicIds.map(id_clinica => ({ id_clinica })) : [] },
    MetaMarketingEnrollmentRequest: {
      findOne: async options => {
        state.enrollmentReads++;
        if (options.where.scope_key !== undefined) assert.equal(options.where.scope_key, scopeKey);
        if (options.lock) { assert.equal(options.lock, options.transaction.LOCK.UPDATE);await locks.acquire(options.transaction, 'enrollment:' + UUID(1)); }
        if (Object.entries(options.where).some(([key, value]) => state.enrollment?.[key] !== value)) return null;
        return state.enrollment && { ...state.enrollment };
      },
      findByPk: async (id, options) => {
        assert.equal(id, UUID(1));assert.equal(options.lock, options.transaction.LOCK.UPDATE);
        if (state.stopRecoveryEnrollment && options.transaction.label !== 'reader' && !options.attributes) state.recoveryEnrollmentAttempts++;
        await locks.acquire(options.transaction, 'enrollment:' + id);
        if (state.enrollmentHook) await state.enrollmentHook(options.transaction);
        if (state.stopRecoveryEnrollment && options.transaction.label !== 'reader' && !options.attributes) return null;
        return { ...enrollment };
      },
    },
    MetaMarketingOAuthRequest: {
      findOne: async options => {
        if (options.lock) await locks.acquire(options.transaction, 'flow:' + flow.flow_id);
        if (!options.attributes) state.flowReads++;return flow;
      },
      findByPk: async (_id, options = {}) => {
        if (options.lock) await locks.acquire(options.transaction, 'flow:' + flow.flow_id);
        if (!options.attributes) state.flowReads++;return flow;
      },
    },
    MetaMarketingBrokerRevocation: { findAll: async () => [] },
    MetaMarketingBrokerBinding: { findAll: async options => {
      if (options.attributes.join(',') === 'enrollment_id') return [{ enrollment_id: UUID(1) }];
      const row = mappings.find(value => value.id === options.where.mapping_id);
      return [{ mapping_id: row.id, enrollment_id: UUID(1), asset_ref: 'meta-' + row.assetType + ':' + row.metaAssetId,
        meta_connection_id: 41, meta_user_id: '301', app_id: '401', connection_ref: 'fictitious-connection', scope_key: scopeKey,
        tenant_clinic_id: clinicIds[0], parent_page_id: null, state: 'active' }];
    } },
    ClinicMetaAsset: { findByPk: async id => ({ ...mappings.find(row => row.id === id) }) },
    MetaMarketingBusinessHandover: { findByPk: async () => null, findOne: async () => null },
    MetaMarketingCredentialRenewal: {}, MetaMarketingEffectiveCredential: {}, PlatformAuditEvent: { sequelize: {},
      count: async () => { state.auditBoundary++;throw Object.assign(Error('FIXTURE_AUDIT_BOUNDARY'), { code: 'fixture_audit_boundary' }); }, min: async () => null },
  };
  if (family === 'oauth') {
    const G = require('../../services/metaMarketingLegacyRecovery.service');
    const snapshot = G.validateSnapshot({ version: 2, scopeKey, clinicIds, sourceConnectionId: 158, canonicalConnectionId: 41,
      appId: '401', subjectId: '301', actorId: 22, mappingIds: [31, 32], newPageCount: 0, cleanup: [], inventory: {
        clinics: clinicIds.map(id_clinica => ({ id_clinica, grupoClinicaId: group })), blocks: [], assignments: [], groups: [], shares: [],
        connections: [{ id: 158, userId: 1, metaUserId: '301', broker_app_id: null, credentials_external: 0, credential_present: 1, credential_sha256: HASH },
          { id: 41, userId: null, metaUserId: '301', broker_app_id: '401', credentials_external: 1, credential_present: 0, credential_sha256: null }],
        aliases: mappings.map(row => ({ id: row.id, metaConnectionId: 158, assetType: row.assetType, metaAssetId: row.metaAssetId,
          assignmentScope: 'group', clinicaId: null, grupoClinicaId: group, isActive: 1, whatsappAuthorizationId: null,
          page_credential_present: 0, page_credential_sha256: null, wa_credential_present: 0, wa_credential_sha256: null,
          additional_data_present: 0, additional_data_sha256: null })),
      } });
    const scopes = ['ads_read', 'public_profile'], slot = { scope_key: scopeKey, connection_ref: 'fictitious-connection', asset_ref: 'meta-enroll:' + scopeKey,
      app_id: '401', clinic_ids: JSON.stringify(clinicIds), scopes: JSON.stringify(scopes), redirect_uri: 'https://auth.example.invalid/oauth/meta/marketing/callback',
      expires_at: new Date(+now + 86400000), state: 'active' };
    Object.assign(flow, { app_id: slot.app_id, clinic_ids: slot.clinic_ids, actor_user_id: 22, session_ref: input.sessionRef, session_expires_at: input.sessionExpiresAt,
      requested_at: new Date(+now - 5000), completed_at: new Date(+now - 1000), scopes: slot.scopes,
      candidate_metadata: JSON.stringify({ versionId: flow.flow_id, digest: HASH, appId: '401', subjectId: '301', tokenType: 'USER', scopes,
        expiresAt: +now + 3600000, dataAccessExpiresAt: null, granularScopes: [] }) });
    enrollment.flow_digest = C.sourceDigest(flow);state.stopRecoveryEnrollment = true;
    state.recovery = { recovery_id: UUID(8), scope_key: scopeKey, clinic_ids: slot.clinic_ids, source_connection_id: 158, canonical_connection_id: null,
      app_id: '401', meta_user_id: '301', mapping_ids: '[31,32]', snapshot: G.encode(snapshot), snapshot_digest: G.hash(G.encode(snapshot)),
      prepared_by_user_id: 22, prepared_at: new Date(+now - 10000), expires_at: new Date(+now + 3500000), state: 'active', flow_id: flow.flow_id,
      candidate_digest: HASH, enrollment_id: enrollment.enrollment_id, bound_at: new Date(+now - 4000), activated_at: new Date(+now - 500), retired_at: null };
    models.MetaMarketingRecovery = { findAll: async () => [state.recovery] };
    models.MetaMarketingOAuthSlot = { findByPk: async () => slot };
  }
  const sessions = { verifyReference: async (_input, options) => {
    state.sessions++;assert.equal(options.requireEmail, true);
    state.references.push(+_input.expiresAt);
    await locks.acquire(options.transaction, 'user:22');await locks.acquire(options.transaction, 'session:' + UUID(7));
    if (!state.verified) throw Object.assign(Error('email'), { code: 'auth_email_verification_required' });
    if (!state.sessionAllowed) throw Object.assign(Error('session'), { code: 'auth_invalid' });
  } };
  const service = require('../../services/' + (family === 'renewal' ? 'metaMarketingCredentialRenewal' : family === 'oauth' ? 'metaMarketingOAuth' : family === 'enrollment' ? 'metaMarketingEnrollment' : 'metaMarketingBusiness') + '.service').createService({
    models, sessions, now: () => now, enabled: () => true, returnOrigin: 'https://app.example.invalid',
    configuration: () => ({ issuerKind: 'BISU', issuerBusinessId: null, configId: '501', graphVersion: 'v24.0' }), discoveryEnabled: () => true,
    audit: { health: async () => assert.fail('No audit write is admitted by this fixture'), append: async () => { state.writes++;assert.fail('No audit write'); } },
    client: { execute: async () => { state.providerCalls++;assert.fail('No broker/provider I/O'); } }, drain: {},
  });
  return { service, input, state, models, locks, sessions };
}

for (const family of ['renewal', 'business']) {
  for (const action of ['overview', 'begin']) {
    test(`${family} ${action} and the actual inbound reader avoid the clinic/enrollment wait cycle`, { timeout: 5000 }, async () => {
      const f = fixture(family), humanClinic = barrier(), readerEnrollment = barrier(), readerClinic = barrier(), releaseHuman = barrier();
      f.state.clinicHook = async (transaction, phase) => {
        if (transaction.label === 'reader' && phase === 'before') readerClinic.resolve();
        if (transaction.label === 'human-1' && phase === 'after') { humanClinic.resolve();await releaseHuman.promise; }
      };
      f.state.enrollmentHook = async transaction => { if (transaction.label === 'reader') readerEnrollment.resolve(); };
      const previous = { META_MARKETING_LEADGEN_ENABLED: process.env.META_MARKETING_LEADGEN_ENABLED, META_MARKETING_BROKER_ENABLED: process.env.META_MARKETING_BROKER_ENABLED };
      process.env.META_MARKETING_LEADGEN_ENABLED = 'true';process.env.META_MARKETING_BROKER_ENABLED = 'true';
      let human, reader;
      try {
        human = f.service[action](f.input).then(() => null, error => error);await humanClinic.promise;
        const inbound = require('../../services/metaMarketingLeadReader.service').forModels(f.models);
        reader = f.locks.run('reader', transaction => inbound.preparePair(32, 31, { transaction })).then(() => null, error => error);
        await readerEnrollment.promise;await readerClinic.promise;releaseHuman.resolve();
        const [humanError, readerError] = await Promise.all([human, reader]);
        assert.equal(f.locks.state.deadlocks, 0, 'admission must not deadlock with the production reader commit');
        assert.equal(humanError?.code, 'meta_oauth_scope_changed');assert.equal(readerError?.code, 'meta_broker_binding_invalid');
        assert.equal(f.state.transactions, 2);assert.equal(f.state.sessions, 3);
        assert.equal(f.state.clinicReads.get('reader'), 1);assert.equal(f.state.clinicReads.get('human-2'), 3);
        assert.equal(f.state.providerCalls, 0);assert.equal(f.state.writes, 0);
      } finally {
        releaseHuman.resolve();await Promise.allSettled([human, reader].filter(Boolean));
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key];else process.env[key] = value; }
      }
    });

    test(`${family} ${action} denies before enrollment inspection and repeats current authorization before hydration`, async () => {
      for (const denial of ['allowed', 'verified', 'sessionAllowed']) {
        const first = fixture(family);first.state[denial] = false;
        await assert.rejects(first.service[action](first.input));assert.equal(first.state.enrollmentReads, 0);assert.equal(first.state.flowReads, 0);assert.equal(first.state.providerCalls, 0);
        for (const absent of [false, true]) {
          const changed = fixture(family);changed.state.afterPreauthorization = () => { changed.state[denial] = false;if (absent) changed.state.enrollment = null; };
          const expected = denial === 'allowed' ? 'meta_oauth_scope_forbidden' : denial === 'verified' ? 'auth_email_verification_required' : 'meta_oauth_session_required';
          await assert.rejects(changed.service[action](changed.input), { code: expected });
          assert.equal(changed.state.sessions, 2);assert(changed.state.enrollmentReads > 0);assert.equal(changed.state.flowReads, 0);assert.equal(changed.state.providerCalls, 0);assert.equal(changed.state.writes, 0);
        }
      }
    });

    test(`${family} ${action} reads current enrollment absence and pins the authorized input across transactions`, async () => {
      const f = fixture(family), expiry = +f.input.sessionExpiresAt;f.state.afterPreauthorization = () => { f.state.enrollment = null;f.input.scopeKey = 'clinic:66';f.input.sessionExpiresAt.setTime(0); };
      if (action === 'begin') await assert.rejects(f.service[action](f.input), { code: `meta_${family}_scope_forbidden` });
      else { const result = await f.service[action](f.input);assert.equal(result[family === 'renewal' ? 'canRenew' : 'canBegin'], false); }
      assert.equal(f.state.sessions, 2);assert(f.state.enrollmentReads > 0);assert.equal(f.state.flowReads, 0);assert.equal(f.state.providerCalls, 0);
      assert(f.state.references.every(value => value === expiry));
    });
  }
}

for (const group of [28, 29]) for (const action of ['status', 'begin']) {
  test(`OAuth ${action} active V2 group${group} and the actual reader avoid the recovered-enrollment wait cycle`, { timeout: 5000 }, async () => {
    const f = fixture('oauth', group), humanClinic = barrier(), readerEnrollment = barrier(), readerClinic = barrier(), releaseHuman = barrier();
    f.state.clinicHook = async (transaction, phase) => {
      if (transaction.label === 'reader' && phase === 'before') readerClinic.resolve();
      if (transaction.label === 'human-1' && phase === 'after') { humanClinic.resolve();await releaseHuman.promise; }
    };
    f.state.enrollmentHook = async transaction => { if (transaction.label === 'reader') readerEnrollment.resolve(); };
    const previous = Object.fromEntries(['META_MARKETING_LEADGEN_ENABLED', 'META_MARKETING_BROKER_ENABLED', 'META_MARKETING_LEGACY_RECOVERY_ENABLED'].map(key => [key, process.env[key]]));
    for (const key of Object.keys(previous)) process.env[key] = 'true';
    let human, reader;
    try {
      human = f.service[action](f.input).then(() => null, error => error);await humanClinic.promise;
      const inbound = require('../../services/metaMarketingLeadReader.service').forModels(f.models);
      reader = f.locks.run('reader', transaction => inbound.preparePair(32, 31, { transaction })).then(() => null, error => error);
      await readerEnrollment.promise;await readerClinic.promise;releaseHuman.resolve();
      const [humanError, readerError] = await Promise.all([human, reader]);
      assert.equal(f.state.recoveryEnrollmentAttempts, 1, 'actual inspectPrepared -> forFlow(active) must reach its exact enrollment query');
      assert.equal(f.locks.state.deadlocks, 0, 'active Recovery capture must not deadlock with the production reader commit');
      assert.equal(humanError?.code, 'meta_recovery_changed');assert.equal(readerError?.code, 'meta_broker_binding_invalid');
      assert.equal(f.state.providerCalls, 0);assert.equal(f.state.writes, 0);
    } finally {
      releaseHuman.resolve();await Promise.allSettled([human, reader].filter(Boolean));
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key];else process.env[key] = value; }
    }
  });
}

for (const action of ['overview', 'status', 'confirm', 'cancel']) {
  const invoke = f => action === 'overview' ? f.service.overview(f.input) : action === 'confirm'
    ? f.service.confirm(f.input, UUID(1), HASH) : f.service[action](f.input, UUID(1));
  test(`Enrollment ${action} and actual reader retain Enrollment before fresh session/Clinic locks`, { timeout: 5000 }, async () => {
    const f = fixture('enrollment'), humanClinic = barrier(), readerEnrollment = barrier(), readerClinic = barrier(), releaseHuman = barrier();
    if (action === 'confirm') { f.state.enrollment.session_ref = f.input.sessionRef;f.state.enrollment.session_expires_at = f.input.sessionExpiresAt; }
    if (action === 'overview') f.state.maximumHumanClinicReads = 1;
    f.state.clinicHook = async (transaction, phase) => {
      if (transaction.label === 'reader' && phase === 'before') readerClinic.resolve();
      if (transaction.label === 'human-1' && phase === 'after') { humanClinic.resolve();await releaseHuman.promise; }
    };
    f.state.enrollmentHook = async transaction => { if (transaction.label === 'reader') readerEnrollment.resolve(); };
    const previous = Object.fromEntries(['META_MARKETING_LEADGEN_ENABLED', 'META_MARKETING_BROKER_ENABLED'].map(key => [key, process.env[key]]));
    for (const key of Object.keys(previous)) process.env[key] = 'true';
    let human, reader, result;
    try {
      human = invoke(f).then(value => { result = value;return null; }, error => error);await humanClinic.promise;
      reader = f.locks.run('reader', transaction => require('../../services/metaMarketingLeadReader.service').forModels(f.models).preparePair(32, 31, { transaction })).then(() => null, error => error);
      await readerEnrollment.promise;await readerClinic.promise;releaseHuman.resolve();
      const [humanError, readerError] = await Promise.all([human, reader]);
      assert.equal(f.locks.state.deadlocks, 0);assert.equal(readerError?.code, 'meta_broker_binding_invalid');
      if (action === 'overview') { assert.equal(humanError, null);assert.equal(result.selection.attentionRequired, true); }
      else assert.equal(humanError?.code, action === 'cancel' ? 'fixture_audit_boundary' : action === 'confirm' ? 'meta_enrollment_scope_changed' : 'meta_oauth_scope_changed');
      if (action === 'cancel') assert(f.state.auditBoundary > 0);
      assert.equal(f.state.providerCalls, 0);assert.equal(f.state.writes, 0);
    } finally {
      releaseHuman.resolve();await Promise.allSettled([human, reader].filter(Boolean));
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key];else process.env[key] = value; }
    }
  });
  test(`Enrollment ${action} rechecks permission/session/email before flow hydration; absent IDs do not lock a PK gap`, async () => {
    for (const denial of ['allowed', 'verified', 'sessionAllowed']) {
      const f = fixture('enrollment');f.state.afterPreauthorization = () => { f.state[denial] = false; };
      await assert.rejects(invoke(f));assert.equal(f.state.sessions, 2);assert.equal(f.state.flowReads, 0);assert.equal(f.state.providerCalls, 0);assert.equal(f.state.auditBoundary, 0);
    }
    const f = fixture('enrollment');f.state.enrollment = null;
    if (action === 'overview') assert.equal((await invoke(f)).selection, null);
    else await assert.rejects(invoke(f), { code: 'meta_enrollment_scope_forbidden' });
    assert(!f.locks.state.trace.some(row => row.resource.startsWith('enrollment:')));assert.equal(f.state.providerCalls, 0);
  });
}

test('changed active Recovery Flow pin closes before any bound Flow or late Enrollment read', async () => {
  const f = fixture('oauth', 29), scope = require('../../services/metaMarketingOAuthScope.service').createScope({ models: f.models, sessions: f.sessions, now: () => new Date('2026-01-01') });
  const previous = process.env.META_MARKETING_LEGACY_RECOVERY_ENABLED;process.env.META_MARKETING_LEGACY_RECOVERY_ENABLED = 'true';
  f.state.recovery.flow_id = UUID(99);
  try {
    await assert.rejects(f.locks.run('capture', transaction => scope.capture(f.input, transaction, { expectedFlowId: UUID(2) })), { code: 'meta_recovery_changed' });
    assert.equal(f.state.recoveryEnrollmentAttempts, 0);assert.equal(f.state.flowReads, 0);assert.equal(f.state.providerCalls, 0);
  } finally { if (previous === undefined) delete process.env.META_MARKETING_LEGACY_RECOVERY_ENABLED;else process.env.META_MARKETING_LEGACY_RECOVERY_ENABLED = previous; }
});

test('identity-only ordering locators deny cross-scope/app/cyclic/malformed lineage and propagate storage failure', async () => {
  for (const bad of ['scope', 'app', 'cycle', 'malformed', 'timeout']) {
    const f = fixture('renewal'), old = { ...f.state.enrollment, enrollment_id: UUID(10), flow_id: UUID(20) };
    if (bad === 'scope') old.scope_key = 'clinic:66';if (bad === 'app') old.app_id = '999';
    f.models.MetaMarketingEnrollmentRequest.findByPk = async id => id === UUID(10) ? old : f.state.enrollment;
    f.models.MetaMarketingBusinessHandover.findByPk = async () => {
      if (bad === 'timeout') throw Object.assign(Error('FIXTURE_STORAGE_TIMEOUT'), { code: 'ETIMEDOUT' });
      return { handover_id: UUID(2), new_enrollment_id: UUID(1), old_enrollment_id: bad === 'cycle' ? UUID(1) : bad === 'malformed' ? 'bad' : UUID(10), scope_key: 'clinic:11', app_id: '401' };
    };
    const order = require('../../services/metaMarketingTransactionOrder.service').createOrder({ models: f.models,
      authorize: require('../../services/metaMarketingOAuthScope.service').createScope({ models: f.models, sessions: f.sessions }).authorize,
      unavailable: () => { throw Object.assign(Error('closed'), { code: 'meta_oauth_unavailable', httpStatus: 503 }); } });
    await assert.rejects(order.flow(f.input, UUID(2), () => assert.fail('Invalid locator cannot enter authority')), { code: bad === 'timeout' ? 'ETIMEDOUT' : 'meta_oauth_unavailable' });
    assert.equal(f.state.transactions, 1);assert.equal(f.state.enrollment.state, 'active');assert.equal(f.state.providerCalls, 0);assert.equal(f.state.writes, 0);
  }
});

test('successful production managed-email scope authorization performs current locking reads only', async () => {
  const S = require('../../services/accessSession.service'), now = new Date('2026-01-01T12:00:00Z'), transaction = { LOCK: { UPDATE: 'UPDATE' } }, reads = [];
  const input = { scopeKey: 'clinic:11', actorId: 22, sessionRef: UUID(7), sessionExpiresAt: new Date(+now + 1800000) };
  const user = { id_usuario: 22, password_usuario: 'FICTITIOUS_PASSWORD_BINDING', email_usuario: 'fixture@example.invalid', estado_cuenta: 'activo', es_provisional: false };
  const secret = 'FICTITIOUS_MANAGED_SESSION_SECRET', row = { ...user, user_id: 22, session_id: input.sessionRef, state: 'active',
    issued_at: new Date(+now - 60000), expires_at: new Date(+now + 3600000), absolute_expires_at: new Date(+now + 3600000),
    authentication_method: 'password_email', email_verified_at: new Date(+now - 61000), email_challenge_id: UUID(9), trusted_device_id: null,
    credential_binding: S.binding(user, secret) };
  const locked = (name, options) => { assert.equal(options.transaction, transaction);assert.equal(options.lock, transaction.LOCK.UPDATE);reads.push(name); };
  const models = { Usuario: { findByPk: async (_id, options) => { locked('user', options);return user; } },
    sequelize: { query: async (sql, options) => { assert.equal(options.transaction, transaction);assert(/FOR UPDATE\s*$/.test(sql));reads.push('session-current');return [[row]]; } },
    Clinica: { findAll: async options => { locked('clinic', options);return [{ id_clinica: 11 }]; } },
    UsuarioClinica: { findAll: async options => { locked('membership', options);return [{ id_clinica: 11 }]; } } };
  const sessions = S.createService({ models, config: () => ({ mode: 'enforce', secret, emailMfaMode: 'enforce', ttl: 43200 }), now: () => now });
  const scope = require('../../services/metaMarketingOAuthScope.service').createScope({ models, sessions, recoveryGuard: {} });
  assert.deepEqual((await scope.authorize(input, transaction)).clinicIds, [11]);
  assert.deepEqual(reads, ['user', 'session-current', 'clinic', 'membership']);
  // A future ordinary SELECT in the successful session path fails the adapter,
  // so it cannot silently create an RR snapshot before a no-journal birth check.
});
