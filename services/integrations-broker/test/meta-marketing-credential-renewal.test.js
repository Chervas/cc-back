'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID, randomBytes } = require('node:crypto');
const { fixture, TOKEN, APP } = require('./meta-marketing-oauth-fixture.cjs');
const C = require('../src/meta-marketing-oauth-contract'), E = require('../src/meta-marketing-enrollment-contract');
const M = require('../src/meta-marketing-contract'), R = require('../src/meta-marketing-credential-renewal-contract');
async function ready(t,options={}) {
  const f = fixture(t, { renewal: true,...options }), flow = await f.begin(), staged = await f.finish(flow), id = randomUUID();
  const p = { enrollmentId: id, flowId: flow.flowId, scopeDigest: flow.payload.scopeDigest,
    candidateDigest: staged.data.candidate.digest, assetRefs: ['meta-ad_account:301', 'meta-facebook_page:401', 'meta-instagram_business:501'] };
  const prepared = (await f.execute(E.OPERATIONS.prepare, p)).data;
  const grant = (await f.execute(E.OPERATIONS.activate, { enrollmentId: id, scopeDigest: p.scopeDigest, selectionDigest: prepared.selectionDigest })).data;
  const read = () => f.execute(M.ASSET, {}, { assetRef: 'meta-ad_account:301' }, 'reader');
  function next(overrides = {}) {
    const current = f.current.epochs.current(f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(id), f.binding);
    const renewalId = randomUUID(), payload = { renewalId, flowId: renewalId, enrollmentId: id,
      expectedEpoch: current.epoch, expectedVersionId: current.versionId, expectedCandidateDigest: current.digest,
      assetSetDigest: R.assetSetDigest(grant.assets), scopeDigest: p.scopeDigest, clinicSetDigest: C.clinicDigest(f.binding.metaMarketingOAuth),
      state: randomBytes(32).toString('base64url'), expiresAt: f.now() + 600000, ...overrides };
    const begin = () => f.execute(R.OPERATIONS.begin, payload);
    const finish = () => f.execute(R.OPERATIONS.finish, { renewalId, flowId: renewalId, state: payload.state, code: 'FICTITIOUS_RENEWAL_CODE_' + renewalId });
    const status = () => f.execute(R.OPERATIONS.status, { renewalId }, {}, true);
    const abort = () => f.execute(R.OPERATIONS.abort, { renewalId }, {}, true);
    const activate = (candidate, options) => f.execute(R.OPERATIONS.activate, { renewalId, enrollmentId: id,
      expectedEpoch: payload.expectedEpoch, expectedVersionId: payload.expectedVersionId, expectedCandidateDigest: payload.expectedCandidateDigest,
      candidateVersionId: renewalId, candidateDigest: candidate.digest }, options);
    return { renewalId, payload, begin, finish, status, abort, activate };
  }
  const immutable = () => JSON.stringify(['meta_marketing_enrollments', 'meta_marketing_enrollment_assets', 'meta_marketing_enrollment_claims', 'asset_revocations']
    .map(table => f.current.store.db.prepare('SELECT * FROM ' + table + ' ORDER BY 1').all()));
  return { f, flow, id, p, grant, next, read, immutable };
}
async function staged(r) { const n = r.next(); await n.begin(); const response = await n.finish(); return { ...n, candidate: response.data.candidate }; }

test('fresh OAuth renews only the effective credential; immutable grant/assets/claims and slot AWSCURRENT survive', async t => {
  const r = await ready(t), before = r.immutable(), original = r.flow.flowId, n = r.next();
  const url = await n.begin(); R.validateResponse(R.OPERATIONS.begin, url.data, n.payload, r.f.binding);
  assert.equal(url.data.flowId, n.renewalId); assert.equal((await r.read()).data.id, 'act_301');
  const response = await n.finish();
  assert.equal(response.data.status, 'staged'); assert.equal(response.data.effectiveCredential.epoch, 0);
  assert(r.f.records.get(r.f.binding.secretArn).get(original).stages.includes(R.retentionStage(r.id, original)));
  assert(!r.f.records.get(r.f.binding.secretArn).get(original).stages.includes('AWSPENDING'));
  assert.equal((await r.read()).data.id, 'act_301', 'old credential still works after AWSPENDING moves');
  const active = (await n.activate(response.data.candidate)).data;
  assert.equal(active.activationApplied, true); assert.equal(active.effectiveCredential.epoch, 1);
  assert.equal(active.effectiveCredential.versionId, n.renewalId); assert.equal((await r.read()).data.id, 'act_301');
  assert.equal(r.immutable(), before); assert.equal(r.f.state.codes, 2); assert.equal(r.f.state.puts, 2);
  assert.deepEqual(r.f.records.get(r.f.binding.secretArn).get(r.f.binding.metaMarketingOAuth.slotVersionId).stages, ['AWSCURRENT']);
  assert.deepEqual(r.f.records.get(r.f.binding.clientSecretArn).get(r.f.binding.metaMarketingOAuth.appVersionId).stages, ['AWSCURRENT']);
  const stored = JSON.stringify(r.f.current.store.db.prepare('SELECT * FROM meta_marketing_credential_renewals').all());
  for (const secret of [TOKEN, APP, n.payload.state, 'FICTITIOUS_RENEWAL_CODE_']) assert(!stored.includes(secret));
});

test('abort/rejected fresh grant preserves the prior current credential and never revokes its authorization', async t => {
  for (const rejected of [false, true]) {
    const r = await ready(t), before = r.immutable(), n = r.next(); await n.begin();
    if (rejected) {
      r.f.state.afterGraph = (kind, value) => kind === 'inspect' ? { data: { ...value.data, user_id: '999' } } : value;
      await assert.rejects(n.finish(), { code: 'oauth_identity_mismatch' }); r.f.state.afterGraph = null;
      assert.equal((await n.status()).data.status, 'rejected');
    }
    assert.equal((await n.abort()).data.status, 'aborted'); assert.equal((await r.read()).data.id, 'act_301');
    assert.equal(r.immutable(), before); assert.equal(r.f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_effective_credentials').get().n, 0);
  }
});

test('server-pinned enrollment/asset-set/epoch and principals reject expansion before any new OAuth or secret mutation', async t => {
  const r = await ready(t);
  for (const patch of [{ expectedEpoch: 3 }, { expectedVersionId: randomUUID() }, { expectedCandidateDigest: 'a'.repeat(64) },
    { assetSetDigest: 'b'.repeat(64) }, { scopeDigest: 'c'.repeat(64) }, { enrollmentId: randomUUID() }]) {
    const n = r.next(patch), before = r.f.state.awsCalls.length;
    await assert.rejects(n.begin()); assert.equal(r.f.state.awsCalls.length, before);
  }
  const n = r.next();
  await assert.rejects(r.f.execute(R.OPERATIONS.begin, n.payload, {}, true), { code: 'scope_denied' });
  await assert.rejects(r.f.execute(R.OPERATIONS.begin, n.payload, {}, 'reader'), { code: 'scope_denied' });
});

test('selected asset loss or changed parent rejects the candidate and never changes the effective pointer', async t => {
  const r = await ready(t), n = r.next(); await n.begin();
  r.f.state.afterGraph = (kind, value) => { if (kind === 'accounts') delete value.data[0].instagram_business_account; return value; };
  await assert.rejects(n.finish(), { code: 'scope_denied' }); r.f.state.afterGraph = null;
  assert.equal((await n.status()).data.status, 'rejected'); assert.equal((await r.read()).data.id, 'act_301');
});

test('renewal preserves the complete configured Lead capability, including explicit granular permission denial', async t => {
  const r = await ready(t,{leads:true}), before=r.immutable(), n=r.next();await n.begin();
  r.f.state.afterGraph=(kind,value)=>kind==='inspect'?{data:{...value.data,granular_scopes:[...value.data.granular_scopes,{scope:'pages_manage_metadata',target_ids:[]}]}}:value;
  await assert.rejects(n.finish(),{code:'scope_denied'});r.f.state.afterGraph=null;
  assert.equal((await n.status()).data.effectiveCredential.epoch,0);assert.equal((await r.read()).data.id,'act_301');assert.equal(r.immutable(),before);
  assert.equal(r.f.current.store.db.prepare('SELECT state FROM meta_marketing_oauth_flows WHERE id=?').get(n.renewalId).state,'aborted');
  const retry=await staged(r);assert.equal((await retry.activate(retry.candidate)).data.effectiveCredential.epoch,1);
});

test('lost activation ACK is reconciled by status without another code exchange, secret Put or pointer change', async t => {
  const r = await ready(t), n = await staged(r), store = r.f.current.store, complete = store.complete.bind(store), requestId = randomUUID();
  store.complete = (...args) => { complete(...args); throw Error('FICTITIOUS_REPLY_LOST_AFTER_COMMIT'); };
  await assert.rejects(n.activate(n.candidate, { requestId })); store.complete = complete;
  const calls = r.f.state.httpCalls.length, puts = r.f.state.puts;
  assert.equal((await n.status()).data.activationApplied, true);
  assert.equal((await n.activate(n.candidate, { requestId })).data.effectiveCredential.epoch, 1);
  assert.equal(r.f.state.httpCalls.length, calls); assert.equal(r.f.state.puts, puts); assert.equal(r.f.state.codes, 2);
});

test('a rolled-back activation requires observed-not-applied status before the same command may retry', async t => {
  const r = await ready(t), n = await staged(r), store = r.f.current.store, append = store.appendAudit.bind(store), requestId = randomUUID();
  store.appendAudit = event => { if (event.reason === 'meta_credential_renewal_activated') throw Error('FICTITIOUS_AUDIT_FAILURE'); return append(event); };
  await assert.rejects(n.activate(n.candidate, { requestId })); store.appendAudit = append;
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_effective_credentials').get().n, 0);
  await assert.rejects(n.activate(n.candidate, { requestId }), { code: 'outcome_unknown' });
  assert.equal((await n.status()).data.status, 'staged');
  assert.equal((await n.activate(n.candidate, { requestId })).data.effectiveCredential.epoch, 1);
  assert.equal(r.f.state.codes, 2);
});

test('a credential epoch change during an active read is a temporary version conflict, never token loss', async t => {
  const r = await ready(t), first = await staged(r); await first.activate(first.candidate);
  const next = await staged(r); let switched = false;
  r.f.state.afterGraph = async (kind, value) => { if (kind === 'asset_ad_account' && !switched) { switched = true; await next.activate(next.candidate); } return value; };
  await assert.rejects(r.read(), { code: 'secret_version_changed' }); r.f.state.afterGraph = null;
  assert.equal((await next.status()).data.effectiveCredential.epoch, 2);
  assert.equal((await r.read()).data.id, 'act_301');
});

test('signed lead receipt admission survives a concurrent effective-token renewal without changing receipt identity', async t => {
  const r=await ready(t,{leads:true}),next=await staged(r),L=require('../src/meta-marketing-leads-contract');
  const {generateKeyPairSync}=require('node:crypto'),{signRequest}=require('../src/auth'),{Broker}=require('../src/broker');
  const keys=generateKeyPairSync('ed25519'),id=L.ingressPrincipal('staging');
  r.f.policy.principals.push({id,keyId:id,enabled:true,maxPerMinute:20,publicKey:keys.publicKey.export({type:'spki',format:'pem'})});
  const broker=new Broker({store:r.f.current.store,policy:r.f.policy,secrets:r.f.secrets,policyResolver:r.f.current.enrollment,
    operations:r.f.current.enrollment.operations,transportProfile:'meta-marketing',now:r.f.now});
  const raw=Buffer.from(JSON.stringify({object:'page',entry:[{id:'401',changes:[{field:'leadgen',value:{leadgen_id:'701',form_id:'702',ad_id:'603'}}]}]}));
  const payload={adAccountAssetRef:'meta-ad_account:301',rawBase64:raw.toString('base64'),
    signature:'sha256='+require('node:crypto').createHmac('sha256',APP).update(raw).digest('hex')};
  const send=()=>{const command=r.f.command(L.OPERATIONS.receiptAccept,payload,{assetRef:'meta-facebook_page:401'}),signed=signRequest(command,{keyId:id,privateKey:keys.privateKey,audience:r.f.policy.audience,now:r.f.now()});return broker.execute(signed.raw,signed.headers);};
  let switched=false;
  r.f.state.afterAws=async(command,result)=>{if(!switched&&command.constructor.name==='GetSecretValueCommand'&&command.input.SecretId===r.f.binding.clientSecretArn){switched=true;await next.activate(next.candidate);}return result;};
  const accepted=(await send()).data;r.f.state.afterAws=null;
  assert.equal(switched,true);assert.equal((await next.status()).data.effectiveCredential.epoch,1);
  const duplicate=(await send()).data;
  assert.equal(duplicate.receipts[0].receiptRef,accepted.receipts[0].receiptRef);
  assert.equal(r.f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_lead_receipts').get().n,1);
});

test('renewal uses actual Meta expiry, permits an expired token to be replaced, and never extends expiry by a universal age', async t => {
  const r = await ready(t); r.f.state.clock += 3601000;
  await assert.rejects(r.read(), { code: 'credential_revoked' });
  const n = await staged(r), active = (await n.activate(n.candidate)).data;
  assert(active.effectiveCredential.metadata.expiresAt > r.f.now());
  assert(active.effectiveCredential.metadata.expiresAt <= r.f.now() + 3600000);
  assert.equal(active.effectiveCredential.metadata.dataAccessExpiresAt, null);
  assert.equal((await r.read()).data.id, 'act_301');
});

test('active grant blocks unrelated initial OAuth and label capacity stops without moving current labels or deleting history', async t => {
  const r = await ready(t), before = r.f.state.awsCalls.length;
  await assert.rejects(r.f.begin(), { code: 'oauth_flow_busy' }); assert.equal(r.f.state.awsCalls.length, before);
  const slot = r.f.records.get(r.f.binding.secretArn).get(r.f.binding.metaMarketingOAuth.slotVersionId);
  slot.stages.push(...Array.from({ length: 18 }, (_, i) => 'FICTITIOUS_RETAINED_' + i));
  const snapshot = JSON.stringify([...r.f.records.get(r.f.binding.secretArn)]), n = r.next();
  await assert.rejects(n.begin(), { code: 'rate_limited' });
  assert.equal(JSON.stringify([...r.f.records.get(r.f.binding.secretArn)]), snapshot);
  assert.equal(r.f.state.puts, 1);
});

test('runtime opt-in is additive and requires exactly the renewal grants; V1 config remains accepted', async t => {
  const runtime = require('../src/meta-marketing-oauth-main'), r = await ready(t);
  runtime.validateConfig(r.f.config);
  const old = fixture(t, { enrollment: true }); runtime.validateConfig(old.config);
  for (const mutate of [v => { v.assetEnrollment = false; }, v => { v.credentialRenewal = 'true'; },
    v => { v.policy.grants[0].operations = v.policy.grants[0].operations.filter(op => op !== R.OPERATIONS.activate); },
    v => { v.policy.grants[1].operations.push(R.OPERATIONS.activate); }]) {
    const v = structuredClone(r.f.config); mutate(v); assert.throws(() => runtime.validateConfig(v), { code: 'invalid_request' });
  }
});

test('explicitly provisioned USER paid Lead grant renews same scope and preserves assets and history', async t => {
  const r=await ready(t,{leads:true,adsManagement:true}),before=r.immutable(),n=r.next();
  const begin=await n.begin();assert(new URL(begin.data.authUrl).searchParams.get('scope').split(',').includes('ads_management'));
  const response=await n.finish();assert(response.data.candidate.metadata.scopes.includes('ads_management'));assert.equal(response.data.effectiveCredential.epoch,0);
  assert.equal((await r.read()).data.id,'act_301');const active=(await n.activate(response.data.candidate)).data;
  assert.equal(active.effectiveCredential.epoch,1);assert(active.effectiveCredential.metadata.scopes.includes('ads_management'));assert.equal(r.immutable(),before);assert.equal((await r.read()).data.id,'act_301');
});
test('cancelled or insufficient USER paid Lead renewal preserves current credential and both clinics', async t => {
  for(const reject of [false,true]){
    const r=await ready(t,{leads:true,adsManagement:true}),before=r.immutable(),n=r.next();await n.begin();
    if(reject){r.f.state.afterGraph=(kind,value)=>kind==='inspect'?{data:{...value.data,scopes:value.data.scopes.filter(s=>s!=='ads_management')}}:value;
      await assert.rejects(n.finish(),{code:'oauth_credentials_incomplete'});r.f.state.afterGraph=null;assert.equal((await n.status()).data.status,'rejected');}
    await n.abort();assert.equal((await r.read()).data.id,'act_301');assert.equal(r.immutable(),before);
    assert.equal(r.f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_effective_credentials').get().n,0);assert.deepEqual(r.f.binding.metaMarketingOAuth.clinicIds,[71,72]);
  }
});
test('adding permission to existing USER binding is not an implicit renewal scope upgrade', async t => {
  const r=await ready(t,{leads:true}),before=r.immutable(),n=r.next(),aws=r.f.state.awsCalls.length;
  r.f.policy.connections[0].metaMarketingOAuth.scopes.push('ads_management');r.f.restart();await assert.rejects(n.begin());assert.equal(r.f.state.awsCalls.length,aws);assert.equal(r.immutable(),before);
  r.f.policy.connections[0].metaMarketingOAuth.scopes.pop();r.f.restart();assert.equal((await r.read()).data.id,'act_301');
});
