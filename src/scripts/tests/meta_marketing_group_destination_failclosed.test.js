'use strict';
require('./fixtures/security_offline_runtime.cjs');
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'); const fs = require('node:fs'); const { Module } = require('node:module');
const C = require('../../services/metaMarketingEnrollment.contract');
const { createDestinations, assignmentDigest } = require('../../services/metaMarketingEnrollmentDestinations.service');
const Admission = require('../../../services/integrations-broker/src/meta-marketing-admission-contract');
const transaction = { LOCK: { UPDATE: 'UPDATE' }, finished: undefined };
const missing = () => Object.assign(Error('PRIVATE_STORAGE_DETAIL'), { original: { code: 'ER_NO_SUCH_TABLE' } });
const unavailable = { code: 'meta_enrollment_unavailable', httpStatus: 503 };
function availability(options = {}) {
  const { enabled = true, admitted = true, model = true, failure = null } = options;
  const exists = Object.hasOwn(options, 'exists') ? options.exists : true;
  const state = { checks: 0, reads: 0, writes: 0 };
  const models = { sequelize: { getQueryInterface: () => ({ tableExists: async (table, options) => {
    state.checks++; assert.equal(table, 'MetaMarketingEnrollmentDestinationPlans'); assert.equal(options.transaction, transaction);
    if (failure) throw failure; return exists;
  } }) } };
  if (model) models.MetaMarketingEnrollmentDestinationPlan = { findByPk: async () => { state.reads++; return null; }, create: async () => { state.writes++; } };
  return { state, models, service: createDestinations({ models, enabled: () => enabled, admitted: () => admitted }) };
}
test('feature OFF retains legacy availability without touching optional model or schema', async () => {
  const f = availability({ enabled: false, model: false, failure: Error('NO_IO') });
  assert.equal(await f.service.available('group:5', transaction, Admission.connectionRef('group:5')), false);
  assert.deepEqual(f.state, { checks: 0, reads: 0, writes: 0 });
});
test('clinic, unadmitted and static group paths stay unavailable without schema access', async () => {
  for (const [scope, ref, admitted] of [['clinic:59', Admission.connectionRef('clinic:59'), true], ['group:5', 'legacy-static-ref', true], ['group:5', undefined, false]]) {
    const f = availability({ admitted, model: false }); assert.equal(await f.service.available(scope, transaction, ref), false); assert.equal(f.state.checks, 0);
  }
});
test('opted-in new group denies missing or nonfunctional persistence model', async () => {
  const f = availability({ model: false }); await assert.rejects(f.service.available('group:5', transaction), unavailable);
  for (const broken of [{}, { findByPk() {} }, { create() {} }]) {
    f.models.MetaMarketingEnrollmentDestinationPlan = broken;
    await assert.rejects(createDestinations({ models: f.models, enabled: () => true, admitted: () => true }).available('group:5', transaction), unavailable);
  }
  assert.equal(f.state.checks, 0); assert.equal(f.state.writes, 0);
});
test('opted-in new group denies absent table and ambiguous metadata responses', async () => {
  for (const exists of [false, null, undefined, 1, 'true', []]) {
    const f = availability({ exists }); await assert.rejects(f.service.available('group:5', transaction), unavailable); assert.equal(f.state.checks, 1); assert.equal(f.state.writes, 0);
  }
});
test('schema metadata failure is a closed 503 without raw storage details', async () => {
  const f = availability({ failure: Error('PRIVATE_STORAGE_DETAIL') });
  await assert.rejects(f.service.available('group:5', transaction), error => error.code === unavailable.code && error.httpStatus === 503 && !error.message.includes('PRIVATE'));
});
test('exact table availability enables the plan capability with the original transaction', async () => {
  const f = availability(); assert.equal(await f.service.available('group:5', transaction, Admission.connectionRef('group:5')), true);
  assert.deepEqual(f.state, { checks: 1, reads: 0, writes: 0 });
});

function loadAuthority(stubs) {
  const filename = require.resolve('../../services/metaMarketingEnrollmentAuthority.service'); const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = module.paths; const original = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : original(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename); return loaded.exports;
}
function pendingFixture({ enabled = true, model = true, table = true, existing = true, state = 'prepared' } = {}) {
  const clock = Date.parse('2026-11-23T02:00:00Z'), flowId = randomUUID(), sessionRef = randomUUID();
  const clinics = [{ id_clinica: 59, grupoClinicaId: 5 }, { id_clinica: 71, grupoClinicaId: 5 }];
  const policies = [{ id_grupo: 5, facebook_assignment_mode: 'clinic', facebook_primary_asset_id: null, instagram_assignment_mode: 'clinic', instagram_primary_asset_id: null }];
  const counters = { authorizations: 0, metadataChecks: 0, planReads: 0, physicalReads: 0, identityReads: 0, writes: 0, inventories: 0 };
  const selected = [{ assetRef: 'meta-ad_account:301', kind: 'ad_account', id: '301', parentPageId: null }];
  const flow = { flow_id: flowId, scope_key: 'group:5', clinic_ids: '[59,71]', connection_ref: Admission.connectionRef('group:5'), asset_ref: 'meta-enroll:group:5', app_id: '101',
    scopes: JSON.stringify(['ads_read', 'public_profile']), redirect_uri: 'https://app.example.invalid/oauth/meta/marketing/callback',
    slot_digest: C.hash('SLOT'), scope_digest: C.hash('SCOPE'), actor_user_id: 9, session_ref: sessionRef, session_expires_at: new Date(clock + 3600000), state_hash: C.hash('STATE'), state: 'staged' };
  const metadata = { versionId: flowId, digest: C.hash('CANDIDATE'), appId: '101', subjectId: '201', tokenType: 'USER', scopes: ['ads_read', 'public_profile'], expiresAt: clock + 3600000, dataAccessExpiresAt: null, granularScopes: [] };
  flow.candidate_metadata = JSON.stringify(metadata);
  const baseDigest = C.hash(JSON.stringify([11, clinics, [], policies]));
  const row = { enrollment_id: randomUUID(), flow_id: flowId, scope_key: flow.scope_key, clinic_ids: flow.clinic_ids, connection_ref: flow.connection_ref,
    scope_digest: flow.scope_digest, flow_digest: C.sourceDigest(flow), candidate_digest: metadata.digest, meta_user_id: '201', app_id: '101', meta_connection_id: 11,
    assets: JSON.stringify(selected), mapping_ids: '[]', actor_user_id: 9, session_ref: sessionRef, session_expires_at: flow.session_expires_at,
    assignment_digest: baseDigest, prepare_request_id: randomUUID(), activate_request_id: randomUUID(), revoke_request_id: randomUUID(), selection_digest: C.hash('SELECTION'),
    state, requested_at: new Date(clock), updated_at: new Date(clock), prepared_at: new Date(clock), activated_at: null, revoked_at: null, attempts: 0,
    next_attempt_at: new Date(clock), lease_token: null, lease_until: null, last_error: null };
  let storedPlan = null;
  const noWrite = async () => { counters.writes++; throw Error('NO_WRITE_EXPECTED'); };
  const models = {
    sequelize: { getQueryInterface: () => ({ tableExists: async () => { counters.metadataChecks++; return table; } }) },
    MetaMarketingOAuthRequest: { findByPk: async () => flow },
    MetaMarketingEnrollmentRequest: { findOne: async () => existing ? row : null, create: noWrite },
    Clinica: { findAll: async () => clinics }, GrupoClinica: { findAll: async () => policies, findByPk: async () => ({ ...policies[0], meta_ad_account_assignment_updated_at: null, facebook_assignment_updated_at: null, instagram_assignment_updated_at: null }) },
    GroupAssetClinicAssignment: { findOne: async () => null }, MetaConnectionAssignment: { findAll: async () => [] },
    MetaMarketingEnrollmentClaim: { findAll: async () => { counters.physicalReads++; return existing ? selected.map(x => ({ asset_ref: x.assetRef, enrollment_id: row.enrollment_id })) : []; }, bulkCreate: noWrite },
    ClinicMetaAsset: { findOne: async () => null }, MetaMarketingBrokerBinding: { findOne: async () => null }, MetaMarketingBrokerRevocation: { findOne: async () => null },
    MetaMarketingEnrollmentIdentity: { create: noWrite }, MetaConnection: { create: noWrite }, PlatformAuditEvent: {},
  };
  if (model) models.MetaMarketingEnrollmentDestinationPlan = { findByPk: async () => { counters.planReads++; if (!table) throw missing(); return storedPlan; }, create: noWrite };
  const destinations = createDestinations({ models, enabled: () => enabled, admitted: () => true });
  const recoveryGuard = { forFlow: async () => null };
  const scope = { authorize: async () => { counters.authorizations++; }, revalidate: async () => {} };
  const source = loadAuthority({ './metaMarketingOAuthScope.service': { createScope: () => scope }, './platformAudit.repository': { createRepository: () => ({ health: async () => ({ pending: 0, oldestAgeSeconds: 0 }), append: noWrite }) },
    './metaMarketingTransactionOrder.service': { pinInput: input => structuredClone(input), createOrder: () => ({ flow: async (input, _id, work) => work({ input, transaction }) }) },
    './metaScopeBlock.service': { blocked: async () => false },
    './metaMarketingCanonicalIdentity.service': { resolveUserIdentity: async () => { counters.identityReads++; return { connection: { id: 11 }, owner: { meta_connection_id: 11 }, provenanceDigest: null }; } },
  });
  const authority = source.createAuthority({ models, sessions: {}, recoveryGuard, destinations, now: () => new Date(clock), enabled: () => true,
    oauth: { assets: async () => { counters.inventories++; return { inventory: { flowId, candidateVersionId: flowId, candidateDigest: metadata.digest, scopeDigest: flow.scope_digest,
      scopeKey: flow.scope_key, clinicSetDigest: C.hash(flow.clinic_ids), observedAt: clock, expiresAt: clock + 200000, accessBlocked: true, availableKinds: ['ad_account'],
      assets: [{ ...selected[0], name: 'FICTITIOUS', accountStatus: 1, currency: 'EUR', timezone: 'Europe/Madrid' }] } }; } } });
  const input = { scopeKey: flow.scope_key, actorId: 9, sessionRef, sessionExpiresAt: flow.session_expires_at };
  const plan = { version: 1, rows: [{ clinicId: 59, assignments: { ad_account: 'meta-ad_account:301' } }, { clinicId: 71, assignments: { ad_account: null } }] };
  return { counters, models, destinations, authority, input, flow, row, plan, baseDigest, setStoredPlan: value => { storedPlan = value; }, reserve: value => authority.reserve(input, flowId, ['meta-ad_account:301'], value) };
}
test('new group reservation with missing model fails before identity, physical claims or DML', async () => {
  const f = pendingFixture({ model: false, existing: false }); await assert.rejects(f.reserve(), unavailable);
  assert.equal(f.counters.physicalReads, 0); assert.equal(f.counters.identityReads, 0); assert.equal(f.counters.writes, 0);
});
test('new group reservation with absent table fails before identity, physical claims or DML', async () => {
  const f = pendingFixture({ table: false, existing: false }); await assert.rejects(f.reserve(f.plan), unavailable);
  assert.equal(f.counters.physicalReads, 0); assert.equal(f.counters.identityReads, 0); assert.equal(f.counters.writes, 0);
});
for (const enabled of [false, true]) for (const model of [false, true]) test(`persisted legacy no-plan intent resumes unchanged: gate=${enabled},model=${model}`, async () => {
  const f = pendingFixture({ enabled, model, table: false }); const before = JSON.stringify(f.row);
  const saved = await f.authority.assertPending(f.row, transaction); assert.equal(saved.assignment_digest, f.baseDigest); assert.equal(saved.destinations, undefined);
  const replay = await f.reserve(); assert.equal(replay.enrollment_id, f.row.enrollment_id); assert.equal(replay.destinations, undefined);
  assert.equal(JSON.stringify(f.row), before); assert.equal(f.counters.metadataChecks, 0); assert.equal(f.counters.writes, 0);
});
test('opting in after table installation does not attach a new plan to a legacy pending selection', async () => {
  const f = pendingFixture(); const before = JSON.stringify(f.row);
  const replay = await f.reserve(); assert.equal(replay.destinations, undefined);
  await assert.rejects(f.reserve(f.plan), { code: 'meta_enrollment_selection_fixed', httpStatus: 409 });
  assert.equal(JSON.stringify(f.row), before); assert.equal(f.counters.writes, 0); assert.equal(f.counters.metadataChecks, 0);
});
test('missing optional model/table preserves legacy active no-plan reads with feature OFF', async () => {
  for (const model of [false, true]) {
    const f = pendingFixture({ enabled: false, model, table: false });
    const active = { ...f.row, state: 'active', mapping_ids: '[101]', activated_at: new Date() };
    assert.equal(await f.destinations.read(active, transaction), null); assert.equal(f.counters.metadataChecks, 0); assert.equal(f.counters.writes, 0);
  }
});
test('a stored opted-in plan remains checked when gate closes; a lost plan never becomes legacy authority', async () => {
  const f = pendingFixture({ enabled: false }); const prepared = f.destinations.prepare(C.request(f.row), f.plan);
  f.row.assignment_digest = assignmentDigest(f.baseDigest, prepared);
  f.setStoredPlan({ plan: JSON.stringify(prepared.plan), digest: prepared.digest, asset_labels: [] });
  assert.deepEqual((await f.authority.assertPending(f.row, transaction)).destinations.plan, f.plan);
  f.setStoredPlan(null);
  await assert.rejects(f.authority.assertPending(f.row, transaction), { code: 'meta_enrollment_scope_changed', httpStatus: 409 });
  assert.equal(f.counters.writes, 0);
});
