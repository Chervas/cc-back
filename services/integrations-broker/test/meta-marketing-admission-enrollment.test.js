'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const C = require('../src/meta-marketing-oauth-contract');
const D = require('../src/meta-marketing-discovery-contract');
const E = require('../src/meta-marketing-enrollment-contract');
const R = require('../src/meta-marketing-credential-renewal-contract');
const { admissionFixture } = require('./meta-marketing-admission-fixture.cjs');

async function candidate(t, { permitEnrollment = true, credentialEpochs = false, credentialRenewal = false, userHealthScopeKeys = [] } = {}) {
  const fixture = admissionFixture(t, {
    discovery: true,
    discoveryScopeKeys: ['clinic:123'],
    enrollment: true,
    enrollmentScopeKeys: permitEnrollment ? ['clinic:123'] : [],
    credentialEpochs, credentialRenewal, userHealthScopeKeys,
  });
  const prepared = fixture.command();
  await fixture.prepare(prepared);
  const begin = fixture.beginCommand(prepared);
  await fixture.execute(begin);
  const send = (operation, payload, handle = fixture.current, control = false) =>
    fixture.execute({ ...prepared, requestId: randomUUID(), operation, payload }, handle, control);
  const staged = await send(C.OPERATIONS.finish, {
    flowId: begin.requestId,
    state: begin.payload.state,
    code: 'FICTITIOUS_DYNAMIC_SELECTION_CODE',
  });
  const flowId = begin.requestId;
  const scopeDigest = begin.payload.scopeDigest;
  const discover = () => send(D.OPERATION, { flowId, scopeDigest });
  const selection = {
    enrollmentId: randomUUID(),
    flowId,
    scopeDigest,
    candidateDigest: staged.data.candidate.digest,
    assetRefs: ['meta-ad_account:301', 'meta-facebook_page:401'],
  };
  return { fixture, prepared, send, discover, selection };
}

test('opted-in first authorization can prepare and confirm exactly its selected assets', async t => {
  const { fixture, prepared, send, discover, selection } = await candidate(t);
  const original = JSON.stringify(fixture.current.broker.policy);
  const catalog = (await discover()).data;
  for (const assetRef of selection.assetRefs) assert(catalog.assets.some(asset => asset.assetRef === assetRef));
  await assert.rejects(send(E.OPERATIONS.prepare, { ...selection, assetRefs: ['meta-ad_account:999'] }), { code: 'scope_denied' });
  const staged = (await send(E.OPERATIONS.prepare, selection)).data;
  assert.equal(staged.status, 'prepared');
  assert.equal(staged.accessBlocked, true);
  const confirmation = {
    enrollmentId: selection.enrollmentId,
    scopeDigest: selection.scopeDigest,
    selectionDigest: staged.selectionDigest,
  };
  const active = (await send(E.OPERATIONS.activate, confirmation)).data;
  assert.equal(active.status, 'active');
  assert.deepEqual(active.assets.map(asset => asset.assetRef).sort(), selection.assetRefs);
  assert.equal(JSON.stringify(fixture.current.broker.policy), original);

  const { signed } = fixture.f;
  const read = signed({
    ...prepared,
    requestId: randomUUID(),
    operation: require('../src/meta-marketing-contract').ASSET,
    assetRef: selection.assetRefs[0],
    payload: {},
  }, 'reader');
  await assert.rejects(fixture.current.broker.execute(read.raw, read.headers), { code: 'scope_denied' });
  const afterRestart = fixture.make();
  const revoked = (await send(E.OPERATIONS.revoke, { enrollmentId: selection.enrollmentId }, afterRestart, true)).data;
  assert.equal(revoked.status, 'revoked');
  assert.equal((await send(E.OPERATIONS.status, { enrollmentId: selection.enrollmentId }, afterRestart, true)).data.status, 'revoked');
});

test('a confirmed self-service clinic can cancel and renew its own credential with its existing assets', async t => {
  const {fixture, prepared, send, selection} = await candidate(t, {credentialEpochs: true, credentialRenewal: true});
  const staged = (await send(E.OPERATIONS.prepare, selection)).data;
  const active = (await send(E.OPERATIONS.activate, {enrollmentId: selection.enrollmentId,
    scopeDigest: selection.scopeDigest, selectionDigest: staged.selectionDigest})).data;
  const {store, epochs, admission} = fixture.current;
  const row = store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(active.enrollmentId);
  const credential = epochs.current(row, admission.resolveBinding(prepared.connectionRef));
  const expected = {expectedEpoch: credential.epoch, expectedVersionId: credential.versionId, expectedCandidateDigest: credential.digest};
  const request = () => {
    const id = randomUUID();
    return {renewalId: id, flowId: id, enrollmentId: active.enrollmentId, ...expected, scopeDigest: active.scopeDigest,
      assetSetDigest: R.assetSetDigest(active.assets), clinicSetDigest: active.clinicSetDigest,
      state: fixture.beginCommand(prepared).payload.state, expiresAt: fixture.f.now()+600000};
  };
  const first = request();
  await assert.rejects(send(R.OPERATIONS.begin, first, fixture.current, true), {code:'scope_denied'});
  const other = fixture.command('clinic:124', [124]); await fixture.prepare(other);
  await assert.rejects(fixture.execute({...other, requestId:randomUUID(), operation:R.OPERATIONS.begin, payload:first}), {code:'scope_denied'});
  await assert.rejects(fixture.execute({...prepared, tenantRef:'clinic:124', requestId:randomUUID(), operation:R.OPERATIONS.begin, payload:first}), {code:'scope_denied'});
  await send(R.OPERATIONS.begin, first);
  assert.equal((await send(R.OPERATIONS.abort, {renewalId:first.renewalId}, fixture.current, true)).data.status, 'aborted');
  assert.equal(epochs.current(row, admission.resolveBinding(prepared.connectionRef)).versionId, credential.versionId);

  const next = request();
  const begin = await send(R.OPERATIONS.begin, next);
  assert.equal(new URL(begin.data.authUrl).hostname, 'www.facebook.com');
  const id = next.renewalId;
  const renewedCredential = (await send(R.OPERATIONS.finish, {renewalId:id, flowId:id, state:next.state, code:'FICTITIOUS_RENEWAL'})).data.candidate;
  assert.equal((await send(R.OPERATIONS.status, {renewalId:id}, fixture.current, true)).data.status, 'staged');
  const activated = await send(R.OPERATIONS.activate, {renewalId:id, enrollmentId:active.enrollmentId, ...expected,
    candidateVersionId:id, candidateDigest:renewedCredential.digest});
  assert.equal(activated.data.effectiveCredential.epoch, credential.epoch+1);
  assert.deepEqual((await send(E.OPERATIONS.status, {enrollmentId:active.enrollmentId})).data.assets, active.assets);
});

test('a dynamic USER health check needs the named control grant and preserves the current epoch', async t => {
  const T = require('../src/meta-marketing-credential-maintenance-contract');
  const {fixture, send, prepared, selection} = await candidate(t, {credentialEpochs:true, credentialRenewal:true, userHealthScopeKeys:['clinic:123']});
  const staged = (await send(E.OPERATIONS.prepare, selection)).data;
  await send(E.OPERATIONS.activate, {enrollmentId:selection.enrollmentId, scopeDigest:selection.scopeDigest, selectionDigest:staged.selectionDigest});
  const {store, epochs, admission} = fixture.current;
  const row = store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(selection.enrollmentId);
  const current = () => epochs.current(row, admission.resolveBinding(prepared.connectionRef));
  const {epoch, versionId, digest} = current();
  const payload = {enrollmentId:row.id, expectedEpoch:epoch, expectedVersionId:versionId, expectedCandidateDigest:digest};
  await assert.rejects(send(T.OPERATIONS.health, payload), {code:'scope_denied'});
  const other = fixture.command('clinic:124',[124]); await fixture.prepare(other);
  await assert.rejects(fixture.execute({...other,requestId:randomUUID(),operation:T.OPERATIONS.health,payload},fixture.current,true), {code:'scope_denied'});
  const checked = await send(T.OPERATIONS.health, payload, fixture.current, true);
  assert.equal(checked.data.healthy, true);
  assert.equal(current().epoch, epoch);
  assert.equal(current().versionId, versionId);
});

test('an admitted gateway can read the selected inventory only for its confirmed clinic', async t => {
  const { fixture, prepared, send, selection } = await candidate(t, { credentialEpochs: true });
  const pending = (await send(E.OPERATIONS.prepare, selection)).data;
  const active = (await send(E.OPERATIONS.activate, {
    enrollmentId: selection.enrollmentId,
    scopeDigest: selection.scopeDigest,
    selectionDigest: pending.selectionDigest,
  })).data;
  const { store, admission } = fixture.current;
  const row = store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(active.enrollmentId);
  const binding = admission.resolveBinding(prepared.connectionRef);
  const credential = fixture.current.epochs.current(row, binding);
  const payload = {
    enrollmentId: active.enrollmentId,
    scopeDigest: active.scopeDigest,
    selectionDigest: active.selectionDigest,
    clinicSetDigest: active.clinicSetDigest,
    assetSetDigest: R.assetSetDigest(active.assets),
    expectedEpoch: credential.epoch,
    expectedVersionId: credential.versionId,
    expectedCandidateDigest: credential.digest,
  };

  const ownership = () => JSON.stringify([
    store.db.prepare('SELECT * FROM meta_marketing_enrollments').all(),
    store.db.prepare('SELECT * FROM meta_marketing_enrollment_assets').all(),
    store.db.prepare('SELECT * FROM meta_marketing_enrollment_claims').all(),
    store.db.prepare('SELECT * FROM asset_revocations').all(),
  ]);
  const before = ownership();
  const response = await send(E.OPERATIONS.assets, payload);
  const inventory = response.data;
  assert.deepEqual(inventory.assets.map(E.identity), active.assets);
  assert(inventory.assets.every(asset => asset.name && asset.name !== asset.id));
  assert.deepEqual(inventory.availableKinds, ['ad_account', 'facebook_page']);
  const events = store.db.prepare('SELECT event FROM audit_outbox').all().map(row => JSON.parse(row.event))
    .filter(event => event.correlationId === response.requestId);
  assert.deepEqual(events.map(event => event.action), ['integration.requested', 'integration.completed']);
  assert(events.every(event => event.connectionRef === prepared.connectionRef && event.tenantRef === prepared.tenantRef
    && event.operation === E.OPERATIONS.assets));

  const request = { ...prepared, operation: E.OPERATIONS.assets, payload };
  const other = fixture.command('clinic:124', [124]);
  await fixture.prepare(other);
  const calls = fixture.f.state.awsCalls.length;
  for (const [changes, role] of [
    [{}, true],
    [{}, 'reader'],
    [{ tenantRef: 'clinic:124', assetRef: 'meta-enroll:clinic:124' }, false],
    [{ payload: { ...payload, assetSetDigest: 'a'.repeat(64) } }, false],
  ]) {
    await assert.rejects(fixture.execute({ ...request, ...changes, requestId: randomUUID() }, fixture.current, role), { code: 'scope_denied' });
  }
  await assert.rejects(fixture.execute({ ...other, operation: E.OPERATIONS.assets, requestId: randomUUID(), payload }), { code: 'scope_denied' });
  assert.equal(fixture.f.state.awsCalls.length, calls, 'denied inventory does not read credential versions');
  assert.equal(ownership(), before);
});

test('discovery without enrollment opt-in cannot prepare a selection', async t => {
  const { fixture, send, discover, selection } = await candidate(t, { permitEnrollment: false });
  assert((await discover()).data.assets.length > 0);
  await assert.rejects(send(E.OPERATIONS.prepare, selection), { code: 'scope_denied' });
  assert.equal(fixture.current.store.db.prepare('SELECT count(*) n FROM meta_marketing_enrollments').get().n, 0);
});

test('changes to the stored admission binding during provider I/O prevent confirmation', async t => {
  const { fixture, send, selection } = await candidate(t);
  const staged = (await send(E.OPERATIONS.prepare, selection)).data;
  let mutated = false;
  fixture.f.state.afterGraph = (kind, value) => {
    if (kind === 'adaccounts' && !mutated) {
      mutated = true;
      fixture.current.store.db.prepare('UPDATE meta_marketing_admission_slots SET expires_at=expires_at+1000 WHERE scope=?').run('clinic:123');
    }
    return value;
  };
  await assert.rejects(send(E.OPERATIONS.activate, {
    enrollmentId: selection.enrollmentId,
    scopeDigest: selection.scopeDigest,
    selectionDigest: staged.selectionDigest,
  }), { code: 'scope_denied' });
  assert.equal(mutated, true);
  assert.equal(fixture.current.store.db.prepare('SELECT state FROM meta_marketing_enrollments WHERE id=?').get(selection.enrollmentId).state, 'prepared');
});

test('runtime configuration requires enrollment to be confined to opted-in discovery scopes', t => {
  const fixture = admissionFixture(t, { enrollment: true, enrollmentScopeKeys: ['clinic:123'] });
  const { validateConfig } = require('../src/meta-marketing-oauth-main');
  const config = { ...fixture.f.config, admission: fixture.settings };
  validateConfig(config);
  for (const mutate of [
    value => { value.admission.discoveryScopeKeys = []; },
    value => { value.admission.enrollmentScopeKeys = ['clinic:124']; },
    value => { value.assetEnrollment = false; },
  ]) {
    const incorrect = structuredClone(config);
    mutate(incorrect);
    assert.throws(() => validateConfig(incorrect), { code: 'invalid_request' });
  }
  const discoveryOnly = structuredClone(config);
  delete discoveryOnly.admission.enrollmentScopeKeys;
  validateConfig(discoveryOnly);
  discoveryOnly.admission.enrollmentScopeKeys = [];
  validateConfig(discoveryOnly);
});

test('a signed multi-clinic webhook uses the app anchor and independently resolves each admitted recipient against its own current clinical grant', async t => {
  const Social=require('../src/meta-marketing-social'), {createHmac}=require('node:crypto');
  const fixtures=admissionFixture(t,{leads:true,enrollment:true,credentialEpochs:true,leadIngress:true,
    enrollmentScopeKeys:['clinic:123','clinic:124'],socialInboxAdvancedChannels:['messenger']});
  async function connected(clinic, page) {
    const command=fixtures.command('clinic:'+clinic,[clinic]); await fixtures.prepare(command);
    const begin=fixtures.beginCommand(command), url=await fixtures.execute(begin);
    const scopes=new URL(url.data.authUrl).searchParams.get('scope').split(',');
    fixtures.f.state.afterGraph=(kind,value)=>{
      if(kind==='inspect') value.data.scopes=scopes;
      if(kind==='accounts') value.data=[{id:page,name:'Fictitious Page '+page}];
      return value;
    };
    const send=(operation,payload)=>fixtures.execute({...command,operation,payload,requestId:randomUUID()});
    const staged=await send(C.OPERATIONS.finish,{flowId:begin.requestId,state:begin.payload.state,code:'FICTITIOUS_CODE_'+clinic});
    const enrollmentId=randomUUID(), scopeDigest=begin.payload.scopeDigest;
    const p=await send(E.OPERATIONS.prepare,{enrollmentId,flowId:begin.requestId,scopeDigest,candidateDigest:staged.data.candidate.digest,assetRefs:['meta-facebook_page:'+page]});
    const active=await send(E.OPERATIONS.activate,{enrollmentId,scopeDigest,selectionDigest:p.data.selectionDigest});
    assert.deepEqual(active.data.quickChatSubscriptionPages,[page]);
    return {send,command,enrollmentId};
  }
  const a=await connected(123,'401'), b=await connected(124,'402');
  const raw=Buffer.from(JSON.stringify({object:'page',entry:[{id:'401'},{id:'402'},{id:'499'}]}));
  const payload={rawBase64:raw.toString('base64'),signature:'sha256='+createHmac('sha256',require('./meta-marketing-oauth-fixture.cjs').APP).update(raw).digest('hex')};
  const read=()=>fixtures.execute({...a.command,requestId:randomUUID(),operation:Social.verify,assetRef:'meta-facebook_page:401',payload},fixtures.current,'leadIngress');
  const before=fixtures.f.state.httpCalls.length;
  assert.deepEqual((await read()).data.destinations,[{accountId:'401',clinicId:123},{accountId:'402',clinicId:124}]);
  await b.send(E.OPERATIONS.revoke,{enrollmentId:b.enrollmentId});
  assert.deepEqual((await read()).data.destinations,[{accountId:'401',clinicId:123}]);
  assert.equal(fixtures.f.state.httpCalls.length,before);
});
