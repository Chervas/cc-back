'use strict';

// Production renewal orchestration with closed authorization/SQL boundaries and
// a deferred fake Owner. There is no network, real model index or database.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const { randomUUID } = require('node:crypto'), { Op } = require('sequelize');
const C = require('../../services/metaMarketingCredentialRenewal.contract');
const ORDER = require('../../services/metaMarketingTransactionOrder.service');
const barrier = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };

function fixture({ quickChat = false, beforeRpc } = {}) {
  let clock = +new Date('2030-01-01T12:00:00Z'), enabled = true;
  const now = () => new Date(clock), HASH = 'a'.repeat(64), initialVersion = randomUUID(), enrollmentId = randomUUID();
  const scopes = ['ads_read', 'public_profile'];
  const metadata = { appId: '101', subjectId: '201', tokenType: 'USER', scopes,
    expiresAt: clock + 86400000, dataAccessExpiresAt: null, granularScopes: [] };
  const initial = { versionId: initialVersion, digest: HASH, ...metadata };
  const assets = [{ assetRef: 'meta-ad_account:301', kind: 'ad_account', id: '301', parentPageId: null }];
  const targets = quickChat ? [{channel:'instagram',clinicId:72,pageId:'401',accountId:'501'}] : [];
  if (quickChat) assets.push({assetRef:'meta-facebook_page:401',kind:'facebook_page',id:'401',parentPageId:null});
  const selected = C.assets(assets);
  const flow = { flow_id: initialVersion, scope_key: 'group:29', app_id: '101', scopes: JSON.stringify(scopes),
    redirect_uri: 'https://auth.example.invalid/oauth/meta/marketing/callback', candidate_metadata: JSON.stringify(initial) };
  const slot = { scope_key: 'group:29', connection_ref: 'fictitious-connection', asset_ref: 'meta-enroll:group:29',
    app_id: '101', clinic_ids: '[66,72]', scopes: flow.scopes, redirect_uri: flow.redirect_uri,
    expires_at: new Date(clock + 86400000), state: 'active' };
  const enrollment = { enrollment_id: enrollmentId, flow_id: initialVersion, session_ref: randomUUID(),
    prepare_request_id: randomUUID(), activate_request_id: randomUUID(), revoke_request_id: randomUUID(),
    scope_digest: HASH, flow_digest: HASH, candidate_digest: HASH, assignment_digest: HASH,
    scope_key: slot.scope_key, actor_user_id: 99, meta_connection_id: 172, connection_ref: slot.connection_ref,
    meta_user_id: '201', app_id: '101', clinic_ids: slot.clinic_ids, assets: JSON.stringify(selected), mapping_ids: quickChat ? '[31,32]' : '[31]',
    session_expires_at: new Date(clock + 10800000), requested_at: now(), updated_at: now(), next_attempt_at: now(),
    prepared_at: now(), activated_at: now(), revoked_at: null, attempts: 0, selection_digest: HASH,
    last_error: null, lease_token: null, lease_until: null, state: 'active' };
  const effective = { epoch: 0, versionId: initialVersion, digest: HASH, metadata, expired: false,
    requiresRenewal: false, healthKind: 'healthy', lastError: null };
  const input = { scopeKey: slot.scope_key, actorId: 99, sessionRef: randomUUID(), sessionExpiresAt: new Date(clock + 10800000) };
  const state = { row: null, owner: null, calls: [], pointerWrites: 0, audits: [] };
  const entered = barrier(), resume = barrier();
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const same = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
  const models = {
    sequelize: { transaction: async (_options, work) => work(tx) },
    MetaMarketingEnrollmentRequest: { findByPk: async () => ({ ...enrollment }) },
    MetaMarketingOAuthRequest: { findByPk: async () => ({ ...flow }) },
    MetaMarketingOAuthSlot: { findByPk: async () => ({ ...slot }) },
    MetaMarketingEffectiveCredential: { create: async () => { state.pointerWrites++; assert.fail('Pointer must not change'); },
      update: async () => { state.pointerWrites++; assert.fail('Pointer must not change'); } },
    MetaMarketingCredentialRenewal: {
      create: async row => { assert.equal(state.row, null); state.row = structuredClone(row); return state.row; },
      findByPk: async id => state.row?.renewal_id === id ? { ...state.row } : null,
      findOne: async ({ where }) => state.row && same(state.row, where) ? { ...state.row } : null,
      findAll: async ({ where }) => state.row && !where.state[Op.notIn].includes(state.row.state)
        && +state.row.next_attempt_at <= +where.next_attempt_at[Op.lte] ? [{ ...state.row }] : [],
      update: async (patch, { where }) => {
        if (!state.row || !same(state.row, where)) return [0];
        Object.assign(state.row, patch); return [1];
      },
    },
  };
  const source = path.resolve(__dirname, '../../services/metaMarketingCredentialRenewal.service.js');
  const loaded = new Module(source, module); loaded.filename = source; loaded.paths = Module._nodeModulePaths(path.dirname(source));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => {
    if (name === './metaMarketingCredentialRenewal.contract') return { ...C, F: { ...C.F,
      createEffectiveCredentials: () => ({ resolve: async () => ({ ...effective }) }) } };
    if (name === './metaMarketingOAuthScope.service') return { createScope: () => ({ authorize: async () => ({ clinicIds: [66, 72] }) }) };
    if (name === './metaMarketingEnrollmentBinding.service') return { createBindings: () => ({ committed: async () => ({}) }) };
    if (name === './metaMarketingTransactionOrder.service') return { ...ORDER, createOrder: () => ({
      scope: async (actor, _options, work) => work({ transaction: tx, enrollment, input: actor }),
      prepareEnrollment: async () => ({ enrollmentId }), lockPrepared: async () => {},
    }) };
    return originalRequire(name);
  };
  loaded._compile(fs.readFileSync(source, 'utf8'), source);
  const receipt = id => ({ renewalId: id, flowId: id, enrollmentId: state.owner ? enrollmentId : null,
    status: state.owner?.status ?? 'not_found', grantDigest: state.owner ? 'b'.repeat(64) : null,
    assetSetDigest: state.owner ? C.F.assetSetDigest(selected) : null,
    effectiveCredential: state.owner ? { epoch: 0, versionId: initialVersion, digest: HASH, metadata } : null,
    candidate: null, activationApplied: false });
  const client = { execute: async command => {
    const name = C.U.validate(command.operation, command.payload); state.calls.push(name);
    if(beforeRpc)await beforeRpc(name,state,command);
    if (name === 'begin') {
      state.owner = { status: 'awaiting' }; entered.release(); await resume.promise;
      const query = new URLSearchParams({ client_id: slot.app_id, redirect_uri: slot.redirect_uri,
        response_type: 'code', scope: (command.payload.quickChat ? require('../../../services/integrations-broker/src/meta-marketing-social-consent').scopesFor(scopes, targets) : scopes).join(','), state: command.payload.state });
      return { requestId: command.requestId, replayed: false, data: { renewalId: command.payload.renewalId,
        flowId: command.payload.renewalId, enrollmentId, authUrl: 'https://www.facebook.com/v24.0/dialog/oauth?' + query,
        expiresAt: command.payload.expiresAt } };
    }
    if (name === 'abort' && state.owner) state.owner.status = 'aborted';
    return { requestId: command.requestId, replayed: false, data: receipt(command.payload.renewalId) };
  } };
  const service = loaded.exports.createService({ models, sessions: {}, client, now, enabled: () => enabled, quickChatTargets: () => targets,
    returnOrigin: 'https://app.example.invalid', audit: {
      health: async () => ({ pending: 0, oldestAgeSeconds: 0 }), append: async event => { state.audits.push(event); },
    } });
  const original = JSON.stringify({ enrollment, flow, effective });
  return { state, input, service, entered, resume, now, advance: ms => { clock += ms; }, disable: () => { enabled = false; },
    assertOriginal: () => { assert.equal(JSON.stringify({ enrollment, flow, effective }), original); assert.equal(state.pointerWrites, 0); } };
}

test('QuickChat obtains explicit consent on an eligible enrollment and preserves its original scopes', async () => {
  const unavailable = fixture();
  await assert.rejects(unavailable.service.begin(unavailable.input,{quickChat:true}),{code:'meta_renewal_scope_forbidden'});
  const f = fixture({quickChat:true});
  const pending = f.service.begin(f.input,{quickChat:true});
  await f.entered.promise;
  f.resume.release();
  const value = await pending;
  const scopes = new URL(value.authUrl).searchParams.get('scope').split(',');
  assert(scopes.includes('instagram_manage_messages') && scopes.includes('instagram_manage_comments'));
  assert.equal(f.state.row.scopes,'["ads_read","public_profile"]');
  f.assertOriginal();
});

test('a deferred begin survives scheduled and manual reconciliation until its Owner response', async () => {
  const f = fixture(), pending = f.service.begin(f.input); await f.entered.promise;
  try {
    assert.equal(f.state.row.state, 'begin_pending');
    assert.equal((await f.service.run()).processed, 0);
    await f.service.reconcile(f.input, f.state.row.renewal_id);
    assert.deepEqual(f.state.calls, ['begin']); assert.equal(f.state.row.state, 'begin_pending');
  } finally { f.resume.release(); }
  const result = await pending;
  assert.equal(result.status, 'awaiting'); assert.equal(f.state.row.state, 'awaiting');
  assert.equal(+f.state.row.next_attempt_at, +f.now() + 30000); f.assertOriginal();
});

test('an abandoned begin is reconciled after expiry and a late response cannot reopen it', async () => {
  const f = fixture(), pending = f.service.begin(f.input).then(value => ({ value }), error => ({ error }));
  await f.entered.promise;
  f.advance(600001);
  assert.equal((await f.service.run()).processed, 1);
  assert.equal(f.state.row.state, 'cancelled'); assert.deepEqual(f.state.calls, ['begin', 'status', 'abort']);
  f.resume.release();
  const result = await pending;
  assert(result.error); assert.equal(f.state.row.state, 'cancelled'); f.assertOriginal();
});

test('explicit cancellation and closed admission can abort an in-flight begin without waiting for expiry', async () => {
  for (const closeAdmission of [false, true]) {
    const f = fixture(), pending = f.service.begin(f.input).then(value => ({ value }), error => ({ error }));
    await f.entered.promise;
    if (closeAdmission) { f.disable(); await f.service.reconcileId(f.state.row.renewal_id); }
    else await f.service.cancel(f.input, f.state.row.renewal_id);
    assert.equal(f.state.row.state, 'cancelled'); assert(f.state.calls.includes('abort'));
    f.resume.release(); const result = await pending;
    assert(result.error); assert.equal(f.state.row.state, 'cancelled'); f.assertOriginal();
  }
});

test('a refused begin reconciles a scoped, fresh not_found without issuing an abort', async () => {
  const f=fixture({beforeRpc(name,state,command){
    if(name==='begin')throw Object.assign(Error('busy'),{code:'oauth_flow_busy'});
    assert.equal(name,'status');assert.equal(command.payload.renewalId,state.row.renewal_id);
    assert.equal(command.tenantRef,'clinic:66');assert.equal(command.assetRef,'meta-enroll:group:29');
    assert.equal(command.connectionRef,state.row.connection_ref);
  }});
  await assert.rejects(f.service.begin(f.input),{code:'meta_renewal_busy',httpStatus:409});
  assert.equal(f.state.row.state,'cancel_pending');
  const closed=await f.service.reconcileId(f.state.row.renewal_id);
  assert.equal(closed.state,'cancelled');assert.equal(closed.pending_enrollment_id,null);
  assert.equal(JSON.parse(closed.owner_receipt).status,'not_found');
  assert.deepEqual(f.state.calls,['begin','status']);f.assertOriginal();
});

test('absence after an uncertain begin stays pending until the authorization window expires', async () => {
  const f=fixture({beforeRpc(name){
    if(name==='begin')throw Object.assign(Error('connection timeout'),{code:'broker_timeout'});
    assert.equal(name,'status');
  }});
  await assert.rejects(f.service.begin(f.input),{code:'broker_timeout'});
  const id=f.state.row.renewal_id;
  assert.equal((await f.service.reconcileId(id)).state,'cancel_pending');
  assert.notEqual(f.state.row.pending_enrollment_id,null);
  assert.equal(+f.state.row.next_attempt_at,+f.state.row.expires_at);assert.equal((await f.service.run()).processed,0);
  f.advance(600001);assert.equal((await f.service.reconcileId(id)).state,'cancelled');f.assertOriginal();
});

test('an interrupted owner keeps exclusion until its exact abort receipt is obtained', async () => {
  let deny=true;
  const f=fixture({beforeRpc(name,row,command){
    if(name==='abort'){
      assert.equal(command.requestId,row.row.abort_request_id);assert.equal(command.payload.renewalId,row.row.renewal_id);
      if(deny)throw Object.assign(Error('permission denied'),{code:'scope_denied'});
    }
  }});
  const request=f.service.begin(f.input);await f.entered.promise;f.resume.release();await request;
  f.state.owner.status='interrupted';
  const id=f.state.row.renewal_id;
  await assert.rejects(f.service.reconcileId(id),{code:'scope_denied'});assert.equal(f.state.row.state,'awaiting');
  assert.notEqual(f.state.row.pending_enrollment_id,null);
  deny=false;const closed=await f.service.reconcileId(id);
  assert.equal(closed.state,'rejected');assert.equal(closed.pending_enrollment_id,null);
  assert.equal(JSON.parse(closed.owner_receipt).status,'aborted');
  assert.deepEqual(f.state.calls,['begin','status','abort','status','abort']);f.assertOriginal();
});

test('an unexpected disappearance after an acknowledged begin fails closed', async () => {
  const f=fixture(), request=f.service.begin(f.input);
  await f.entered.promise;f.resume.release();await request;f.state.owner=null;
  await assert.rejects(f.service.reconcileId(f.state.row.renewal_id),{code:'broker_response_invalid'});
  assert.equal(f.state.row.state,'awaiting');assert.notEqual(f.state.row.pending_enrollment_id,null);
  assert.deepEqual(f.state.calls,['begin','status']);f.assertOriginal();
});


test('cancelling an acknowledged exchange does not need its missing candidate version', async () => {
  const f = fixture({beforeRpc: async name => {
    if (name === 'status') throw Object.assign(Error('candidate absent'), {code:'secret_unavailable'});
  }});
  const begin = f.service.begin(f.input);
  await f.entered.promise;
  f.resume.release();
  await begin;
  f.state.row.state = 'processing';
  f.state.row.code_digest = 'c'.repeat(64);
  f.state.owner.status = 'processing';
  await f.service.cancel(f.input, f.state.row.renewal_id);
  assert.equal(f.state.row.state, 'cancelled');
  assert.equal(f.state.row.pending_enrollment_id, null);
  assert.deepEqual(f.state.calls, ['begin','abort']);
  f.assertOriginal();
});
