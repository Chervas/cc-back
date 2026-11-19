'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, generateKeyPairSync } = require('node:crypto');
const { randomUUID } = require('node:crypto');
const { fixture: apiFixture } = require('./fixtures/business_profile_first_profile.fixture');
const { fixture: ownerFixture } = require('../../../services/integrations-broker/test/helpers');
const { Broker } = require('../../../services/integrations-broker/src/broker');
const { signRequest } = require('../../../services/integrations-broker/src/auth');
const { cursorCodec } = require('../../../services/integrations-broker/src/provider-cursor');
const { createBusinessProfileEnrollment } = require('../../../services/integrations-broker/src/google-business-profile-enrollment');
const E = require('../../../services/integrations-broker/src/google-business-profile-enrollment-contract');
const R = require('../../../services/integrations-broker/src/google-business-profile-contract');

function fixture(t, { ownerClinic = 123, subject = '113861427645841982815', enrollment = false, locations=['300'] } = {}) {
  const f = ownerFixture(t), state = { secretReads: 0, providerCalls: [], commands: [], lostAck: null };
  const roles = {};
  for (const id of ['read', 'control']) {
    const keys = generateKeyPairSync('ed25519'); roles[id] = id + ':test';roles[id+'Key']=keys.privateKey;
    f.policy.principals.push({ id: roles[id], keyId: id + '-key', enabled: true,
      publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }), maxPerMinute: 100 });
  }
  const binding = { connectionRef: 'connection:test', provider: R.PROVIDER, initialState: 'active',
    oauth: { subject: '113861427645841982815', redirectUri: 'https://example.invalid/oauth/google/callback',
      scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/business.manage'] },
    googleBusinessProfileEnrollmentScopes: [{ assetRef: 'gbp-enroll:clinic:' + ownerClinic, tenantRef: 'clinic:' + ownerClinic,
      accountIds: ['100'], locationIds: locations, bootstrapPreviousAssetRef: null,
      readPrincipalId: roles.read, controlPrincipalId: roles.control, readOperations: [...R.OPERATIONS], maxAssets: 1 }] };
  f.policy.connections = [binding];
  f.policy.grants = [{ principalId: 'api:test', tenantRef: 'clinic:' + ownerClinic, connectionRef: binding.connectionRef,
    assetRef: 'gbp-enroll:clinic:' + ownerClinic, operations: enrollment ? [E.OPERATIONS.discover,E.OPERATIONS.prepare,E.OPERATIONS.activate,E.OPERATIONS.status] : [E.OPERATIONS.discover] },
    ...(enrollment?[{principalId:roles.control,tenantRef:'clinic:'+ownerClinic,connectionRef:binding.connectionRef,assetRef:'gbp-enroll:clinic:'+ownerClinic,operations:[E.OPERATIONS.retire,E.OPERATIONS.abort]}]:[])];
  const http = async request => {
    state.providerCalls.push({ hostname: request.hostname, path: request.path });
    assert.equal(request.token.toString(), 'FICTITIOUS_FIRST_PROFILE_TOKEN');
    if (request.hostname === 'www.googleapis.com') return { id: subject };
    if (request.hostname === 'mybusinessaccountmanagement.googleapis.com') return { name: 'accounts/100', accountName: 'FICTITIOUS_ACCOUNT' };
    assert.equal(request.hostname, 'mybusinessbusinessinformation.googleapis.com');
    assert(request.path.startsWith('/v1/accounts/100/locations?'));
    return { locations: ['300', '400'].map(id => ({ name: 'locations/' + id, title: 'FICTITIOUS_' + id,
      metadata:{hasVoiceOfMerchant:true,newReviewUri:'https://search.google.com/local/writereview?placeid=FICTITIOUS_'+id} })) };
  };
  const engine = createBusinessProfileEnrollment({ store: f.store, http, cursor: cursorCodec(randomBytes(32)) });
  const broker = new Broker({ store: f.store, policy: f.policy, operations: engine.operations, gbpEnrollment: engine,
    secrets: { async withSecret(_binding, work) {
      state.secretReads++; const value = Buffer.from('FICTITIOUS_FIRST_PROFILE_TOKEN');
      try { return await work(value); } finally { value.fill(0); }
    } } });
  const transport = { async execute(command) {
    state.commands.push(structuredClone(command));
    const key=command.operation.endsWith('.abort.v1')||command.operation.endsWith('.retire.v1')?roles.control:'api:test';
    const principal=f.policy.principals.find(row=>row.id===key);
    const privateKey=key==='api:test'?f.keys.privateKey:roles.controlKey;
    const signed = signRequest(command, { keyId: principal.keyId, privateKey, audience: f.policy.audience });
    const result=await broker.execute(signed.raw, signed.headers);
    if(state.lostAck===command.operation){state.lostAck=null;throw Object.assign(Error('broker_timeout'),{code:'broker_timeout'});}
    return result;
  } };
  return { ...f, state, transport };
}

test('first-profile API and real Owner return only exact preauthorized location, without creating an enrollment or local grant', async t => {
  const owner = fixture(t), api = apiFixture({ transport: owner.transport }), before = structuredClone(api.state);
  const result = await api.service.candidates(api.input);
  assert.deepEqual(result.accounts[0].locations.map(row => row.locationId), ['locations/300']);
  assert(!JSON.stringify(result).includes('FICTITIOUS_FIRST_PROFILE_TOKEN'));
  assert.equal(result.canPrepare, true); assert.deepEqual(api.state, before);
  assert.equal(owner.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments').get().n, 0);
  assert.equal(owner.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_scope_heads').get().n, 0);
  assert.equal(owner.state.secretReads, 1); assert.equal(owner.state.providerCalls.length, 3);
});
test('another Owner clinic cannot authorize the API tenant and denies before reading its secret', async t => {
  const owner = fixture(t, { ownerClinic: 124 }), api = apiFixture({ transport: owner.transport });
  await assert.rejects(api.service.candidates(api.input), { code: 'scope_denied' });
  assert.equal(owner.state.secretReads, 0); assert.equal(owner.state.providerCalls.length, 0);
  assert.equal(api.state.BusinessProfileAssociationScope.length, 0);
});
test('real Owner rejects mismatched Google subject and omits a previously retired location', async t => {
  const wrong = fixture(t, { subject: 'other-subject' }), wrongApi = apiFixture({ transport: wrong.transport });
  await assert.rejects(wrongApi.service.candidates(wrongApi.input), { code: 'oauth_identity_mismatch' });
  assert.equal(wrong.state.providerCalls.length, 1);
  const owner = fixture(t), api = apiFixture({ transport: owner.transport });
  owner.store.db.prepare('INSERT INTO google_business_profile_retirements(tenant,connection,asset,location,enrollment_id,retired_at) VALUES (?,?,?,?,?,?)')
    .run('clinic:999', 'connection:other', 'gbp:777:300', '300', 'fictitious-retirement', Date.now());
  assert.deepEqual((await api.service.candidates(api.input)).accounts, []);
  assert.equal(owner.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_retirements').get().n, 1);
  assert.equal(api.state.BusinessProfileAssociationScope.length, 0);
});
async function select(api,id='300') {
  const inventory=await api.service.candidates(api.input);
  return {attemptId:randomUUID(),sourceFingerprint:inventory.sourceFingerprint,accountName:'accounts/100',locationName:'locations/'+id};
}
test('first selection atomically persists one local scope and normal durable attempt; explicit confirmation alone activates it',async t=>{
  const owner=fixture(t,{enrollment:true}),api=apiFixture({transport:owner.transport,writable:true}),payload=await select(api);
  const result=await api.service.prepare(api.input,payload);
  assert.equal(result.firstProfileSourceFingerprint,payload.sourceFingerprint);
  assert.equal(result.attempt.state,'prepared');assert.equal(result.attempt.current,null);assert.equal(result.attempt.canConfirm,true);
  assert.notEqual(result.attempt.sourceFingerprint,payload.sourceFingerprint);
  assert.equal(api.state.BusinessProfileAssociationScope.length,1);
  assert.deepEqual(api.state.BusinessProfileAssociationScope[0].account_ids,['100']);assert.deepEqual(api.state.BusinessProfileAssociationScope[0].location_ids,['300']);
  assert.equal(api.state.BusinessProfileAssociationRequest.length,1);assert.equal(api.state.ClinicBusinessLocation.length,1);assert.equal(api.state.ClinicBusinessLocation[0].is_active,false);
  const inserts=api.writes.filter(write=>write.operation==='create');assert.equal(new Set(inserts.map(write=>write.transaction)).size,1);
  assert(inserts.every(write=>write.transaction.finished==='commit'));
  const commands=owner.state.commands.length;await api.service.prepare(api.input,payload);assert.equal(owner.state.commands.length,commands);
  await assert.rejects(api.service.prepare(api.input,{...payload,locationName:'locations/400'}),{code:'idempotency_conflict'});
  const confirmed=await api.ordinary.confirm(api.input,payload.attemptId);
  assert.equal(confirmed.attempt.state,'active',JSON.stringify({state:confirmed.attempt.state,error:confirmed.attempt.error,commands:owner.state.commands.map(command=>command.operation)}));assert.equal(api.state.ClinicBusinessLocation[0].is_active,true);
  assert.equal(owner.store.db.prepare("SELECT COUNT(*) AS n FROM google_business_profile_enrollments WHERE state='active'").get().n,1);
});
test('a failed atomic insert or audit preserves absence of local scope and no Owner preparation is dispatched',async t=>{
  for(const failure of ['ClinicBusinessLocation','BusinessProfileAssociationRequest','BusinessProfileBrokerBinding','audit']){
    const owner=fixture(t,{enrollment:true}),api=apiFixture({transport:owner.transport,writable:true}),payload=await select(api);
    if(failure==='audit')api.control.failAudit=true;else api.control.failCreate=failure;
    await assert.rejects(api.service.prepare(api.input,payload));
    assert.equal(api.state.BusinessProfileAssociationScope.length,0);assert.equal(api.state.BusinessProfileAssociationRequest.length,0);assert.equal(api.state.ClinicBusinessLocation.length,0);assert.equal(api.state.BusinessProfileBrokerBinding.length,0);
    assert(!owner.state.commands.some(command=>command.operation===E.OPERATIONS.prepare));
  }
});
test('lost preparation and activation acknowledgements reconcile the same durable attempt without duplicate activations',async t=>{
  const owner=fixture(t,{enrollment:true}),api=apiFixture({transport:owner.transport,writable:true}),payload=await select(api);
  owner.state.lostAck=E.OPERATIONS.prepare;
  const pending=await api.service.prepare(api.input,payload);assert.equal(pending.attempt.state,'prepare_pending');assert.equal(pending.attempt.canConfirm,false);assert.equal(api.state.ClinicBusinessLocation[0].is_active,false);
  api.clock.at+=120000;assert.equal((await api.ordinary.read(api.input,payload.attemptId)).attempt.state,'prepared');
  assert.equal(owner.state.commands.filter(command=>command.operation===E.OPERATIONS.prepare).length,1);
  owner.state.lostAck=E.OPERATIONS.activate;
  assert.equal((await api.ordinary.confirm(api.input,payload.attemptId)).attempt.state,'activate_pending');assert.equal(api.state.ClinicBusinessLocation[0].is_active,false);
  api.clock.at+=120000;assert.equal((await api.ordinary.read(api.input,payload.attemptId)).attempt.state,'active');
  assert.equal(owner.state.commands.filter(command=>command.operation===E.OPERATIONS.activate).length,1);assert.equal(api.state.BusinessProfileAssociationRequest.length,1);
});
test('Owner permission to discover does not manufacture a preparation acknowledgement or activate the local mapping',async t=>{
  const owner=fixture(t),api=apiFixture({transport:owner.transport,writable:true}),payload=await select(api);
  const result=await api.service.prepare(api.input,payload);assert.equal(result.attempt.state,'prepare_pending');assert.equal(result.attempt.canConfirm,false);assert.equal(result.attempt.error,'scope_denied');
  assert.equal(api.state.ClinicBusinessLocation[0].is_active,false);assert.equal(api.state.BusinessProfileBrokerBinding[0].state,'staged');
  assert.equal(owner.store.db.prepare('SELECT COUNT(*) AS n FROM google_business_profile_enrollments').get().n,0);
});
test('cancelled first reservation can explicitly select another Owner-authorized profile without erasing history or widening local scope',async t=>{
  const owner=fixture(t,{enrollment:true,locations:['300','400']}),api=apiFixture({transport:owner.transport,writable:true}),first=await select(api);
  await api.service.prepare(api.input,first);assert.equal((await api.ordinary.cancel(api.input,first.attemptId)).attempt.state,'cancelled');
  assert.equal(api.state.ClinicBusinessLocation[0].is_active,false);assert.deepEqual(api.state.BusinessProfileAssociationScope[0].location_ids,['300']);
  const ready=await api.service.preflight(api.input);assert.equal(ready.enabled,true);assert.equal(ready.canPrepare,true);
  const second=await select(api,'400'),oldMapping=structuredClone(api.state.ClinicBusinessLocation[0]);
  const result=await api.service.prepare(api.input,second);assert.equal(result.attempt.state,'prepared');
  assert.deepEqual(api.state.BusinessProfileAssociationScope[0].location_ids,['400']);assert.deepEqual(api.state.ClinicBusinessLocation[0],oldMapping);
  assert.equal(api.state.BusinessProfileAssociationRequest.length,2);assert.equal((await api.ordinary.read(api.input,first.attemptId)).attempt.state,'cancelled');
  await assert.rejects(api.service.prepare(api.input,first));assert.deepEqual(api.state.BusinessProfileAssociationScope[0].location_ids,['400']);
  assert.equal((await api.ordinary.confirm(api.input,second.attemptId)).attempt.state,'active');
  assert.equal(api.state.ClinicBusinessLocation.filter(row=>row.is_active).length,1);assert.equal(api.state.ClinicBusinessLocation.find(row=>row.is_active).location_id,'locations/400');
  assert.equal(owner.store.db.prepare("SELECT COUNT(*) AS n FROM google_business_profile_enrollments WHERE state='cancelled'").get().n,1);
});
test('lost cancellation acknowledgement blocks reselection until the ordinary cancellation is reconciled',async t=>{
  const owner=fixture(t,{enrollment:true,locations:['300','400']}),api=apiFixture({transport:owner.transport,writable:true}),payload=await select(api);
  await api.service.prepare(api.input,payload);owner.state.lostAck=E.OPERATIONS.abort;
  assert.equal((await api.ordinary.cancel(api.input,payload.attemptId)).attempt.state,'cancel_pending');
  const blocked=await api.service.preflight(api.input);assert.equal(blocked.enabled,false);assert.equal(blocked.reason,'gbp_first_profile_existing_history');
  await assert.rejects(api.service.candidates(api.input));assert.deepEqual(api.state.BusinessProfileAssociationScope[0].location_ids,['300']);
  api.clock.at+=120000;assert.equal((await api.ordinary.read(api.input,payload.attemptId)).attempt.state,'cancelled');assert.equal((await api.service.preflight(api.input)).enabled,true);
  assert.equal(owner.state.commands.filter(command=>command.operation===E.OPERATIONS.abort).length,1);
});
test('failed reselection rolls back the previous single-profile reservation and preserves the cancelled attempt',async t=>{
  const owner=fixture(t,{enrollment:true,locations:['300','400']}),api=apiFixture({transport:owner.transport,writable:true}),first=await select(api);
  await api.service.prepare(api.input,first);await api.ordinary.cancel(api.input,first.attemptId);
  const second=await select(api,'400'),before=structuredClone(api.state);api.control.failCreate='ClinicBusinessLocation';
  await assert.rejects(api.service.prepare(api.input,second));assert.deepEqual(api.state,before);
  assert(!owner.state.commands.some(command=>command.operation===E.OPERATIONS.prepare&&command.payload.locationId==='400'));
});
test('loss of clinic permission after preparation blocks activation and cannot be repaired by replaying first admission',async t=>{
  const owner=fixture(t,{enrollment:true}),api=apiFixture({transport:owner.transport,writable:true}),payload=await select(api);
  await api.service.prepare(api.input,payload);api.state.UsuarioClinica[0].rol_clinica='paciente';
  await assert.rejects(api.ordinary.confirm(api.input,payload.attemptId),{code:'scope_denied'});await assert.rejects(api.service.prepare(api.input,payload));
  assert(!owner.state.commands.some(command=>command.operation===E.OPERATIONS.activate));assert.equal(api.state.ClinicBusinessLocation[0].is_active,false);
});
test('review impact is consistent across preflight/catalogue and requires unchanged explicit consent before registration',async t=>{
  const owner=fixture(t,{enrollment:true}),api=apiFixture({transport:owner.transport,writable:true});
  api.state.MarketingPatientList.push({id:55,clinica_id:123,grupo_clinica_id:9,status:'paused',criteria:{review_request:1},clinic_ids:[123]});
  const preflight=await api.service.preflight(api.input),inventory=await api.service.candidates(api.input);
  assert.equal(preflight.sourceFingerprint,inventory.sourceFingerprint);assert.equal(preflight.reviewDestinationChangeRequired,true);assert.equal(inventory.affectedReviewCampaignCount,1);
  const payload={attemptId:randomUUID(),sourceFingerprint:inventory.sourceFingerprint,accountName:'accounts/100',locationName:'locations/300'};
  await assert.rejects(api.service.prepare(api.input,payload),{code:'gbp_association_campaign_dependency'});assert.equal(api.state.BusinessProfileAssociationScope.length,0);
  const result=await api.service.prepare(api.input,{...payload,reviewDestinationChangeAccepted:true});assert.equal(result.attempt.state,'prepared');assert.equal(result.attempt.reviewDestinationChangeAccepted,true);
  api.state.MarketingPatientList.push({id:56,clinica_id:123,status:'paused',criteria:{review_request:1},clinic_ids:[123]});
  await assert.rejects(api.ordinary.confirm(api.input,payload.attemptId),{code:'gbp_association_review_impact_changed'});
  assert(!owner.state.commands.some(command=>command.operation===E.OPERATIONS.activate));assert(api.state.MarketingPatientList.every(row=>row.status==='paused'));
});
test('first preparation lookup never locks a UUID before authority and reuses normal scope-before-attempt ordering',async t=>{
  const owner=fixture(t,{enrollment:true}),api=apiFixture({transport:owner.transport,writable:true}),payload=await select(api);
  await api.service.prepare(api.input,payload);api.calls.length=0;await api.service.prepare(api.input,payload);
  const hint=api.calls.findIndex(call=>call.name==='BusinessProfileAssociationRequest'&&call.method==='findByPk'&&!call.options.lock);
  const scope=api.calls.findIndex(call=>call.name==='BusinessProfileAssociationScope'&&call.options.lock);
  const locked=api.calls.findIndex(call=>call.name==='BusinessProfileAssociationRequest'&&call.method==='findByPk'&&call.options.lock);
  assert(hint>=0&&scope>hint&&locked>scope);
});
test('a concurrent committed first selection is reconciled during catalogue only for the exact original intent',async t=>{
  const owner=fixture(t,{enrollment:true}),api=apiFixture({transport:owner.transport,writable:true}),payload=await select(api);
  await api.service.prepare(api.input,payload);const before=structuredClone(api.state),commands=owner.state.commands.length;
  const replayAfterInitialMiss=()=>{
    const repository=require('../../services/businessProfileAssociation.repository').createRepositoryForAssociation({
      models:api.models,sessions:api.sessions,audit:api.audit,enabled:()=>true,now:()=>new Date(api.clock.at)});
    let first=true;
    return require('../../services/businessProfileFirstProfile.service').createFirstProfileService({
      models:api.models,sessions:api.sessions,client:api.client,audit:api.audit,associationService:api.ordinary,
      repository:{...repository,async firstHistory(...args){if(first){first=false;return null;}return repository.firstHistory(...args);}},
      enabled:()=>true,now:()=>api.clock.at});
  };
  // The initial UUID lookup missed before the winner committed. The following
  // catalogue observes its existing scope + pending/prepared intent instead.
  const result=await replayAfterInitialMiss().prepare(api.input,payload);assert.equal(result.attempt.state,'prepared');
  await assert.rejects(replayAfterInitialMiss().prepare(api.input,{...payload,attemptId:randomUUID()}),{code:'gbp_first_profile_existing_history'});
  await assert.rejects(replayAfterInitialMiss().prepare(api.input,{...payload,locationName:'locations/400'}),{code:'idempotency_conflict'});
  assert.deepEqual(api.state,before);assert.equal(owner.state.commands.length,commands);
});
test('only fully acknowledged first cancellations permit reselection; active, leased, revoked or unproved history stays closed',async t=>{
  const owner=fixture(t,{enrollment:true,locations:['300','400']}),api=apiFixture({transport:owner.transport,writable:true}),payload=await select(api);
  await api.service.prepare(api.input,payload);await api.ordinary.cancel(api.input,payload.attemptId);const baseline=structuredClone(api.state);
  for(const mutate of [
    state=>{state.BusinessProfileAssociationRequest[0].lease_token=randomUUID();},
    state=>{state.ClinicBusinessLocation[0].is_active=true;},
    state=>{delete state.BusinessProfileAssociationRequest[0].target_snapshot.firstProfileAdmission;},
    state=>{state.BusinessProfileAssociationScope[0].state='blocked';},
    state=>{state.BusinessProfileBrokerBinding[0].current_generation_id=randomUUID();},
    state=>{state.BusinessProfileBrokerRevocation.push({external_location_id:'300',clinica_id:123,state:'confirmed'});},
  ]){
    for(const key of Object.keys(baseline))api.state[key]=structuredClone(baseline[key]);mutate(api.state);const before=structuredClone(api.state),commands=owner.state.commands.length;
    assert.equal((await api.service.preflight(api.input)).enabled,false);await assert.rejects(api.service.candidates(api.input));
    assert.equal(owner.state.commands.length,commands);assert.deepEqual(api.state,before);
  }
});
