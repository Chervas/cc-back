'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Op } = require('sequelize');
const { createRecovery, encode, hash, ALIAS_ATTRIBUTES, CONNECTION_ATTRIBUTES } = require('../../services/metaMarketingLegacyRecovery.service');
const APP = '1807844546609897', SUBJECT = '24532330033025968';
function fixture({ version = 1 } = {}) {
  const preparedAt = new Date('2026-11-04T12:00:00Z'); let clock = +preparedAt + 5000;
  const state = { enabled: true, mfa: true, updates: 0, bindings: [], selections: [], connections: [{ id: 158, userId: 1, metaUserId: SUBJECT, broker_app_id: null,
    credentials_external: 0, credential_present: 1, credential_sha256: 'a'.repeat(64) }],
  aliases: [], recovery: null, flow: null, enrollment: null };
  const alias = (id, type, extra = {}) => ({ id, metaConnectionId: 158, assetType: type, metaAssetId: String(180000000000000 + id),
    assignmentScope: 'group', clinicaId: 1, grupoClinicaId: 28, isActive: id === 359 ? 1 : 0, whatsappAuthorizationId: null,
    page_credential_present: 0, page_credential_sha256: null, wa_credential_present: 0, wa_credential_sha256: null,
    additional_data_present: 0, additional_data_sha256: null, ...extra });
  state.aliases = [alias(359, 'ad_account'), alias(360, 'instagram_business'), alias(361, 'facebook_page',
    { page_credential_present: 1, page_credential_sha256: 'b'.repeat(64) }), alias(362, 'whatsapp_phone_number',
    { isActive: 1, whatsappAuthorizationId: randomUUID(), wa_credential_present: 1, wa_credential_sha256: 'c'.repeat(64) })];
  const clinics = [{ id_clinica: 1, grupoClinicaId: 28 }, { id_clinica: 70, grupoClinicaId: 28 }];
  const blocks = [{ scope_key: 'clinic:1', reason: 'scope_disconnected', connection_id: 158, actor_user_id: 1, created_at: new Date('2026-09-13T12:00:00Z') }];
  const assignments = [
    { id: 11, scopeKey: 'clinic:1', assignmentScope: 'clinic', clinicaId: 1, grupoClinicaId: null, metaConnectionId: 158, status: 'disconnected', updated_at: preparedAt },
    { id: 17, scopeKey: 'group:28', assignmentScope: 'group', clinicaId: null, grupoClinicaId: 28, metaConnectionId: 158, status: 'active', updated_at: preparedAt },
  ];
  const groups = [{ id_grupo: 28, facebook_assignment_mode: 'manual', facebook_primary_asset_id: 361,
    instagram_assignment_mode: 'manual', instagram_primary_asset_id: 360, ads_assignment_mode: 'automatic', ads_assignment_delimiter: '**' }];
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    Clinica: { findAll: async () => clinics }, MetaScopeBlock: { findAll: async () => blocks },
    MetaConnection: { findAll: async options => { state.selections.push({ model: 'connection', options }); return options.where.id ? state.connections.filter(row => row.id === options.where.id) : state.connections; } },
    ClinicMetaAsset: { findAll: async options => { state.selections.push({ model: 'alias', options }); return options.where.id ? state.aliases.filter(row => options.where.id[Op.in].includes(row.id)) : state.aliases; },
      update: async (patch, options) => { let count = 0; for (const row of state.aliases) if (options.where.id[Op.in].includes(row.id) && row.metaConnectionId === options.where.metaConnectionId && row.assetType === options.where.assetType) { Object.assign(row, patch); count++; } return [count]; } },
    MetaConnectionAssignment: { findAll: async () => assignments }, GroupAssetClinicAssignment: { findAll: async () => [] }, GrupoClinica: { findAll: async () => groups },
    MetaMarketingOAuthRequest: { findByPk: async id => state.flow?.flow_id === id ? state.flow : null },
    MetaMarketingEnrollmentRequest: { findByPk: async id => state.enrollment?.enrollment_id === id ? state.enrollment : null,
      update: async (patch, options) => { if (!state.enrollment || !Object.entries(options.where).every(([key, value]) => state.enrollment[key] === value)) return [0]; Object.assign(state.enrollment, patch); return [1]; } },
    MetaMarketingBrokerBinding: { findAll: async options => state.bindings.filter(row => row.enrollment_id === options.where.enrollment_id),
      update: async (patch, options) => { let count = 0; for (const row of state.bindings) if (row.enrollment_id === options.where.enrollment_id && row.meta_connection_id === options.where.meta_connection_id && options.where.mapping_id[Op.in].includes(row.mapping_id)) { Object.assign(row, patch); count++; } return [count]; } },
    MetaMarketingRecovery: {
      findAll: async options => state.recovery && (options.where.scope_key === undefined || state.recovery.scope_key === options.where.scope_key)
        && (options.where.recovery_id ? options.where.recovery_id[Op.in].includes(state.recovery.recovery_id) : options.where.state[Op.in].includes(state.recovery.state)) ? [state.recovery] : [],
      findOne: async options => state.recovery && Object.entries(options.where).every(([key, value]) => state.recovery[key] === value) ? state.recovery : null,
      findByPk: async id => state.recovery?.recovery_id === id ? state.recovery : null,
      update: async (patch, options) => {
        if (!state.recovery || !Object.entries(options.where).every(([key, value]) => state.recovery[key] === value)) return [0];
        state.updates++; Object.assign(state.recovery, patch); return [1];
      },
    },
  };
  const sessions = { verifyReference: async (_actor, options) => { assert.equal(options.requireEmail, true); if (!state.mfa) throw Error('mfa_required'); } };
  const guard = createRecovery({ models, sessions, enabled: () => state.enabled, now: () => new Date(clock) });
  const input = { scopeKey: 'group:28', clinicIds: [1, 70], sourceConnectionId: 158, appId: APP, subjectId: SUBJECT, actorId: 1, mappingIds: [359] };
  if (version === 2) {
    Object.assign(input, { version: 2, canonicalConnectionId: 159, newPageCount: 0, cleanup: [] });
    state.connections.push({ id: 159, userId: null, metaUserId: SUBJECT, broker_app_id: APP, credentials_external: 1, credential_present: 0, credential_sha256: null });
  }
  const actor = { ...input, sessionRef: randomUUID(), sessionExpiresAt: new Date(+preparedAt + 86400000) };
  async function prepare() {
    const snapshot = await guard.captureSnapshot(input, tx);
    state.recovery = { recovery_id: randomUUID(), scope_key: input.scopeKey, clinic_ids: '[1,70]', source_connection_id: 158, canonical_connection_id: null,
      app_id: APP, meta_user_id: SUBJECT, mapping_ids: '[359]', snapshot: encode(snapshot), snapshot_digest: hash(encode(snapshot)),
      prepared_by_user_id: 1, prepared_at: preparedAt, expires_at: new Date(+preparedAt + 3600000), state: 'prepared',
      flow_id: null, candidate_digest: null, enrollment_id: null, bound_at: null, activated_at: null, retired_at: null };
    return snapshot;
  }
  function flow(stateName = 'staged') {
    const id = randomUUID(), scopes = ['ads_read', 'public_profile'];
    state.flow = { flow_id: id, scope_key: input.scopeKey, app_id: APP, clinic_ids: '[1,70]', actor_user_id: 1,
      session_ref: actor.sessionRef, session_expires_at: actor.sessionExpiresAt, requested_at: new Date(+preparedAt + 1000),
      completed_at: stateName === 'staged' ? new Date(+preparedAt + 2000) : null, state: stateName, scopes: JSON.stringify(scopes),
      candidate_metadata: stateName === 'staged' ? JSON.stringify({ versionId: id, digest: 'd'.repeat(64), appId: APP, subjectId: SUBJECT, tokenType: 'USER', scopes,
        expiresAt: +preparedAt + 86400000, dataAccessExpiresAt: null, granularScopes: [] }) : null };
    return state.flow;
  }
  async function canonical() {
    if (!state.connections.some(row => row.id === 159)) state.connections.push({ id: 159, userId: null, metaUserId: SUBJECT, broker_app_id: APP, credentials_external: 1, credential_present: 0, credential_sha256: null });
    return guard.bindCanonical({ flow: state.flow, canonicalConnectionId: 159 }, tx);
  }
  async function activate() {
    await prepare(); flow(); const pending = await guard.forFlow(state.flow, tx); await canonical();
    const enrollmentId = randomUUID(); await guard.attachEnrollment({ flow: state.flow, enrollmentId }, tx);
    state.enrollment = { enrollment_id: enrollmentId, state: 'active', flow_id: state.flow.flow_id, scope_key: 'group:28', meta_connection_id: 159,
      app_id: APP, meta_user_id: SUBJECT,
      mapping_ids: '[359]', candidate_digest: state.recovery.candidate_digest, lease_token: randomUUID(), attempts: 7 };
    state.bindings = [{ enrollment_id: enrollmentId, mapping_id: 359, meta_connection_id: 159, state: 'active' }];
    Object.assign(state.aliases[0], { metaConnectionId: 159, clinicaId: null, isActive: 1 });
    const active = await guard.activate({ flow: state.flow, enrollment: state.enrollment }, tx);
    assert.equal(active.immutableDigest, pending.immutableDigest); return active;
  }
  // The real prefix/context validator runs against a closed metadata adapter;
  // these are locator fields, never a substitute Recovery authority proof.
  const matches = (row, where) => row && Object.entries(where).every(([key, value]) => row[key] === value);
  models.MetaMarketingEnrollmentRequest.findOne = async options => matches(state.enrollment, options.where) ? state.enrollment : null;
  models.MetaMarketingOAuthRequest.findOne = async options => matches(state.flow, options.where) ? state.flow : null;
  models.sequelize = { query: async (sql, options) => {
    assert.equal(options.transaction, tx);assert.match(sql, /FOR UPDATE NOWAIT$/);
    const row = sql.includes('`MetaMarketingEnrollmentRequests`') ? state.enrollment
      : sql.includes('`MetaMarketingOAuthRequests`') ? state.flow
      : sql.includes('`MetaMarketingRecoveries`') && ['prepared','flow_bound','active'].includes(state.recovery?.state) ? state.recovery : null;
    return [[...(row?.scope_key === options.bind.scopeKey ? [row] : [])]];
  } };
  async function retirement(scope,clinicIds){
    const block=require('../../services/metaScopeBlock.service'),preparedContext=await block.prepareRetirement({scope,clinicIds,models});
    await block.lockRetirement(preparedContext,tx,{models});await block.validateRetirement(preparedContext,tx,{models});
    return {scope,clinicIds,preparedContext};
  }
  return { guard, state, models, sessions, input, actor, tx, prepare, flow, canonical, activate, retirement, blocks, assignments, tick: value => { clock += value; } };
}

test('recovery preparation records only credential presence and SQL digests; admission is off by default', async () => {
  const f = fixture(); const snapshot = await f.prepare();
  assert.equal(snapshot.inventory.connections[0].credential_present, 1);
  assert.equal(snapshot.inventory.aliases.find(row => row.id === 361).page_credential_present, 1);
  assert(!CONNECTION_ATTRIBUTES.some(value => value === 'accessToken')); assert(!ALIAS_ATTRIBUTES.some(value => ['pageAccessToken', 'waAccessToken', 'additionalData'].includes(value)));
  f.state.enabled = false; assert.equal(await f.guard.inspectPrepared(f.actor, f.tx), null); assert.equal(f.state.updates, 0);
});

test('fresh consent binds once, creates a separate empty canonical identity, and adopts only the reviewed Ads alias', async () => {
  const f = fixture(); const legacy = encode([f.state.connections[0], f.state.aliases.slice(1), f.blocks, f.assignments]);
  const active = await f.activate(); assert.equal(active.canonicalConnectionId, 159); assert.equal(active.sourceConnectionId, 158);
  assert.deepEqual(active.mappingIds, [359]); assert.equal(active.aliases[0].credentials_absent, 1);
  assert.equal(encode([f.state.connections[0], f.state.aliases.slice(1), f.blocks, f.assignments]), legacy);
  f.tick(3600001); f.state.mfa = false;
  assert.equal((await f.guard.assertActive({ enrollmentId: active.enrollmentId }, f.tx)).recoveryId, active.recoveryId);
});

test('the status capture retains its immutable generation digest after binding and activation', async () => {
  const f = fixture(); await f.prepare();
  const before = await f.guard.inspectPrepared(f.actor, f.tx); f.flow();
  await f.guard.forFlow(f.state.flow, f.tx);
  assert.equal((await f.guard.inspectPrepared(f.actor, f.tx)).immutableDigest, before.immutableDigest);
  const g = fixture(); const active = await g.activate(); g.tick(3600001);
  g.state.flow.session_expires_at = new Date('2026-11-04T12:00:00Z');
  assert.equal((await g.guard.inspectPrepared(g.actor, g.tx)).immutableDigest, active.immutableDigest);
});

test('awaiting callbacks retain the prepared digest without binding or granting business access', async () => {
  const f = fixture(); await f.prepare(); f.flow('awaiting');
  const proof = await f.guard.forFlow(f.state.flow, f.tx); assert.equal(proof.flowId, null); assert.equal(f.state.updates, 0);
  await assert.rejects(() => f.guard.forFlow(f.state.flow, f.tx, { phase: 'active' }));
  f.state.mfa = false; await assert.rejects(() => f.guard.forFlow(f.state.flow, f.tx), { code: 'meta_recovery_actor_required' });
});

test('a second flow, changed subject or expired initial claim cannot acquire the generation', async () => {
  const f = fixture(); await f.prepare(); f.flow(); await f.guard.forFlow(f.state.flow, f.tx);
  f.flow(); await assert.rejects(() => f.guard.forFlow(f.state.flow, f.tx));
  const g = fixture(); await g.prepare(); g.flow(); const candidate = JSON.parse(g.state.flow.candidate_metadata); candidate.subjectId = '999'; g.state.flow.candidate_metadata = JSON.stringify(candidate);
  await assert.rejects(() => g.guard.forFlow(g.state.flow, g.tx));
  const h = fixture(); await h.prepare(); h.flow(); h.tick(3600000); await assert.rejects(() => h.guard.forFlow(h.state.flow, h.tx), { code: 'meta_recovery_expired' });
});
test('V2 bound within its preparation window continues the same flow after expiry with unchanged immutable authority', async () => {
  const f=fixture({version:2});await f.prepare();f.flow();const before=await f.guard.forFlow(f.state.flow,f.tx);
  const immutable={snapshot:f.state.recovery.snapshot,digest:f.state.recovery.snapshot_digest,prepared:+f.state.recovery.prepared_at,expires:+f.state.recovery.expires_at,bound:+f.state.recovery.bound_at};
  f.tick(3600001);const after=await f.guard.forFlow(f.state.flow,f.tx);assert.equal(after.immutableDigest,before.immutableDigest);
  await f.canonical();await f.guard.attachEnrollment({flow:f.state.flow,enrollmentId:randomUUID()},f.tx);
  assert.deepEqual({snapshot:f.state.recovery.snapshot,digest:f.state.recovery.snapshot_digest,prepared:+f.state.recovery.prepared_at,expires:+f.state.recovery.expires_at,bound:+f.state.recovery.bound_at},immutable);
});
test('continuity does not admit unbound, V1, late or invalid bindings, another flow, expired session/candidate or changed pins', async () => {
  const unbound=fixture({version:2});await unbound.prepare();unbound.flow();unbound.tick(3600001);
  await assert.rejects(unbound.guard.forFlow(unbound.state.flow,unbound.tx),{code:'meta_recovery_expired'});
  const old=fixture();await old.prepare();old.flow();await old.guard.forFlow(old.state.flow,old.tx);old.tick(3600001);
  await assert.rejects(old.guard.forFlow(old.state.flow,old.tx),{code:'meta_recovery_expired'});
  for(const mutate of [f=>f.state.recovery.bound_at=new Date(+f.state.recovery.prepared_at-1),f=>f.state.recovery.bound_at=new Date(+f.state.recovery.expires_at),
    f=>f.state.recovery.bound_at=new Date(NaN),f=>f.state.mfa=false,f=>f.state.flow.session_expires_at=new Date(0),
    f=>{const value=JSON.parse(f.state.flow.candidate_metadata);value.expiresAt=+f.state.recovery.expires_at;f.state.flow.candidate_metadata=JSON.stringify(value);},
    f=>f.flow(),f=>f.state.connections[0].credential_sha256='f'.repeat(64)]){
    const f=fixture({version:2});await f.prepare();f.flow();await f.guard.forFlow(f.state.flow,f.tx);f.tick(3600001);mutate(f);
    await assert.rejects(f.guard.forFlow(f.state.flow,f.tx));
  }
});

test('a raw block, shared assignment or legacy secret changed after preparation invalidates the exact pinned generation', async () => {
  for (const change of [
    f => { f.blocks[0].created_at = new Date('2026-11-04T13:00:00Z'); },
    f => { f.assignments[0].updated_at = new Date('2026-11-04T13:00:00Z'); },
    f => { f.state.connections[0].credential_sha256 = 'e'.repeat(64); },
  ]) {
    const f = fixture(); await f.prepare(); f.flow(); change(f);
    await assert.rejects(() => f.guard.forFlow(f.state.flow, f.tx), { code: 'meta_recovery_changed' }); assert.equal(f.state.updates, 0);
  }
});

test('unrelated WhatsApp/profile changes are not a live dependency of the selected Meta generation', async () => {
  const f = fixture(); await f.prepare(); f.flow();
  f.state.aliases[3].wa_credential_sha256 = 'f'.repeat(64);
  f.state.aliases[2].page_credential_sha256 = 'f'.repeat(64);
  await f.guard.forFlow(f.state.flow, f.tx);
  const g = fixture(); const proof = await g.activate();
  g.state.aliases[3].wa_credential_sha256 = 'f'.repeat(64); g.state.connections[0].credential_sha256 = 'f'.repeat(64);
  g.state.aliases[2].page_credential_sha256 = 'f'.repeat(64); g.assignments[0].updated_at = new Date();
  const result = await g.guard.assertActive({ enrollmentId: proof.enrollmentId }, g.tx);
  assert.equal(result.recoveryId, proof.recoveryId);
  assert.equal(g.state.selections.filter(row => row.model === 'connection').at(-1).options.where.id, 159);
});

test('canonical credentials, outside aliases, or retirement cannot be bypassed by new UUIDs', async () => {
  const f = fixture(); await f.activate(); f.state.connections[1].credential_present = 1; f.state.connections[1].credential_sha256 = 'f'.repeat(64);
  await assert.rejects(() => f.guard.assertActive({ enrollmentId: f.state.enrollment.enrollment_id }, f.tx), { code: 'meta_recovery_canonical_invalid' });
  const g = fixture(); await g.activate(); g.state.aliases.push({ ...g.state.aliases[0], id: 999 });
  await assert.rejects(() => g.guard.assertActive({ enrollmentId: g.state.enrollment.enrollment_id }, g.tx));
  const h = fixture(); const proof = await h.activate(); h.state.enabled = false; await h.guard.retire(proof.enrollmentId, h.tx); h.state.enabled = true;
  await assert.rejects(() => h.guard.assertActive({ enrollmentId: proof.enrollmentId }, h.tx), { code: 'meta_recovery_retired' });
});

test('a source identity is never repurposed as canonical, and a selected credential-bearing alias is not adoptable', async () => {
  const f = fixture(); await f.prepare(); f.flow(); await f.guard.forFlow(f.state.flow, f.tx);
  await assert.rejects(() => f.guard.bindCanonical({ flow: f.state.flow, canonicalConnectionId: 158 }, f.tx), { code: 'meta_recovery_canonical_invalid' });
  assert.equal(f.state.recovery.canonical_connection_id, null);
  const g = fixture(); g.state.aliases[0].page_credential_present = 1; g.state.aliases[0].page_credential_sha256 = 'e'.repeat(64);
  await assert.rejects(() => g.prepare(), { code: 'meta_recovery_invalid' });
});

test('a scope withdrawal retires only owned canonical mappings and queues the existing control outbox, even with admission off', async () => {
  const f = fixture(); const proof = await f.activate(); f.state.enabled = false;
  const peers = encode([f.state.connections[0], f.state.aliases.slice(1), f.blocks, f.assignments]);
  const lease = f.state.enrollment.lease_token;
  await assert.rejects(()=>f.guard.retireForScope({scope:{assignmentScope:'clinic',clinicId:1},clinicIds:[1]},f.tx),{code:'meta_security_state_unavailable'});
  const result = await f.guard.retireForScope(await f.retirement({ assignmentScope: 'clinic', clinicId: 1 },[1]), f.tx);
  assert.equal(result.retired, 1); assert.equal(result.enrollmentsQueued, 1);
  assert.equal(f.state.recovery.state, 'retired'); assert.equal(f.state.enrollment.state, 'revoke_pending');
  assert.equal(f.state.enrollment.attempts, 0); assert.equal(f.state.enrollment.lease_token, lease);
  assert.equal(f.state.bindings[0].state, 'blocked'); assert.equal(f.state.aliases[0].isActive, false);
  assert.equal(encode([f.state.connections[0], f.state.aliases.slice(1), f.blocks, f.assignments]), peers);
  assert.equal((await f.guard.retireForScope(await f.retirement({ assignmentScope: 'clinic', clinicId: 1 },[1]), f.tx)).retired, 0);
  f.state.enabled = true;
  await assert.rejects(() => f.guard.assertActive({ enrollmentId: proof.enrollmentId }, f.tx), { code: 'meta_recovery_retired' });
});

test('an unrelated scope does not retire this generation, and only an absent optional DEV table can be skipped', async () => {
  const f = fixture(); await f.activate();
  assert.equal((await f.guard.retireForScope(await f.retirement({ assignmentScope: 'clinic', clinicId: 99 },[99]), f.tx)).retired, 0);
  f.models.MetaMarketingRecovery.findAll = async () => { throw Object.assign(Error('missing'), { original: { code: 'ER_NO_SUCH_TABLE' } }); };
  const development = createRecovery({ models: f.models, sessions: f.sessions, enabled: () => false, isDevelopment: () => true });
  assert.equal((await development.prepareRetirement({ scope: { assignmentScope: 'clinic', clinicId: 1 }, clinicIds: [1] })).reason, 'meta_recovery_dev_table_absent');
  const staging = createRecovery({ models: f.models, sessions: f.sessions, enabled: () => false, isDevelopment: () => false });
  await assert.rejects(() => staging.prepareRetirement({ scope: { assignmentScope: 'clinic', clinicId: 1 }, clinicIds: [1] }));
  f.models.MetaMarketingRecovery.findAll = async () => { throw Object.assign(Error('denied'), { original: { code: 'ER_TABLEACCESS_DENIED_ERROR' } }); };
  await assert.rejects(() => development.prepareRetirement({ scope: { assignmentScope: 'clinic', clinicId: 1 }, clinicIds: [1] }));
});
