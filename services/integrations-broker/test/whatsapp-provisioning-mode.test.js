'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { provisioningFixture } = require('./whatsapp-provisioning-fixture.cjs');
const C = require('../src/whatsapp-onboarding-contract');
const P = require('../src/whatsapp-provisioning-contract');
const { broaden } = require('./whatsapp-companion-fixture.cjs');
const profile = p => ({...p.settings,scopes:[...p.settings.scopes,'public_profile','whatsapp_business_manage_events']});
const capable = p => ({...profile(p),coexistenceGrantPolicy:C.PROVIDER_GRANT_POLICY});
const modeCommand = (p,mode,scope='clinic:123',ids=[123]) => {
  const value=p.command(scope,ids);value.payload.mode=mode;return value;
};
const slot = (handle,scope='clinic:123') => handle.store.db.prepare('SELECT * FROM whatsapp_provisioned_slots WHERE scope=?').get(scope);
async function begin(p,handle,cmd) {
  const value={...cmd,requestId:randomUUID(),operation:C.OPERATIONS.begin,payload:{
    state:randomBytes(32).toString('base64url'),expiresAt:p.f.now()+600000,
    scopeDigest:cmd.payload.scopeDigest,clinicSetDigest:cmd.payload.clinicSetDigest}};
  await p.execute(value,handle);return value;
}
test('Capability and signed mode are closed enums; legacy digests and overrides remain identical',t=>{
  const p=provisioningFixture(t),base=profile(p),enabled=capable(p);
  assert.equal(P.settingsDigest(base),P.settingsDigest(enabled));
  for(const invalid of [null,false,true,'accept-all',{},'strict-v1']){
    assert.throws(()=>P.validateSettings({...base,coexistenceGrantPolicy:invalid}),{code:'invalid_request'});
    assert.throws(()=>P.validatePublicTemplate({...P.publicTemplate(base),coexistenceGrantPolicy:invalid}),{code:'invalid_request'});
  }
  assert.throws(()=>P.validateSettings({...p.settings,coexistenceGrantPolicy:C.PROVIDER_GRANT_POLICY}),{code:'invalid_request'});
  const overridden={...enabled,grantPolicyOverrides:[{scopeKey:'clinic:1',policy:C.PROVIDER_GRANT_POLICY}]};
  assert.equal(P.publicBinding(overridden,'clinic:1',[1]).customer.providerGrantPolicy,C.PROVIDER_GRANT_POLICY);
  assert.equal(P.publicBinding(overridden,'clinic:1',[1],'cloud_api').customer.providerGrantPolicy,undefined);
  assert.equal(P.publicBinding(overridden,'clinic:70',[70]).customer.providerGrantPolicy,undefined);
  assert.equal(P.publicBinding(overridden,'clinic:70',[70],'coexistence').customer.providerGrantPolicy,C.PROVIDER_GRANT_POLICY);
  for(const invalid of [null,'business','',true,undefined]){
    const cmd=modeCommand(p,invalid);
    assert.throws(()=>P.validatePreparation(cmd.payload,p.f.now()),{code:'invalid_request'});
  }
});
test('New Cloud and coexistence slots pin independent policies, preserve placeholder identity and survive restart',async t=>{
  const p=provisioningFixture(t),settings=capable(p),h=p.make(undefined,settings);
  const cloud=modeCommand(p,'cloud_api'),coex=modeCommand(p,'coexistence','clinic:124',[124]);
  await p.prepare(cloud,h);await p.prepare(coex,h);
  assert.equal(slot(h).provider_grant_policy,P.STRICT_GRANT_POLICY);
  assert.equal(slot(h,'clinic:124').provider_grant_policy,C.PROVIDER_GRANT_POLICY);
  const before=[123,124].map(id=>C.fingerprint(h.provisioner.resolveBinding(P.connectionRef('clinic:'+id))));
  const rows=[slot(h),slot(h,'clinic:124')];
  h.close();const withoutCapability=p.make(undefined,profile(p));
  assert.deepEqual([123,124].map(id=>C.fingerprint(withoutCapability.provisioner.resolveBinding(P.connectionRef('clinic:'+id)))),before);
  assert.deepEqual([slot(withoutCapability),slot(withoutCapability,'clinic:124')],rows);
  assert.equal(p.state.creates,2);assert.equal(p.f.state.codes,0);assert.equal(p.f.state.puts,0);
  await assert.rejects(p.prepare(cloud,withoutCapability).then(()=>p.prepare(modeCommand(p,'cloud_api','clinic:124',[124]),withoutCapability)),{code:'idempotency_conflict'});
});
test('Legacy SQLite adds only a nullable column and preserves complete rows and frozen fingerprints',async t=>{
  const p=provisioningFixture(t),base=profile(p),legacy=p.make(undefined,base),cmd=p.command();await p.prepare(cmd,legacy);
  const binding=legacy.provisioner.resolveBinding(cmd.connectionRef),fingerprint=C.fingerprint(binding);
  legacy.store.db.exec('ALTER TABLE whatsapp_provisioned_slots DROP COLUMN provider_grant_policy');
  const old=slot(legacy);legacy.close();
  const upgraded=p.make(undefined,capable(p)),current=slot(upgraded);
  assert.equal(current.provider_grant_policy,null);delete current.provider_grant_policy;
  assert.deepEqual(current,old);
  assert.equal(C.fingerprint(upgraded.provisioner.resolveBinding(cmd.connectionRef)),fingerprint);
  assert.deepEqual(upgraded.provisioner.resolveBinding(cmd.connectionRef),binding);
});
test('An interrupted strict attempt must be aborted before an empty legacy slot can adopt coexistence',async t=>{
  const p=provisioningFixture(t),legacy=p.make(undefined,profile(p)),cmd=p.command();await p.prepare(cmd,legacy);
  const flow=await begin(p,legacy,cmd);
  p.f.state.afterGraph=(request,response)=>request.action==='inspect'?broaden(response):response;
  await assert.rejects(p.execute({...cmd,requestId:randomUUID(),operation:C.OPERATIONS.finish,payload:{
    flowId:flow.requestId,state:flow.payload.state,code:'FICTITIOUS_MIXED_GRANT',wabaId:'301',phoneId:'401'}},legacy));
  assert.equal(legacy.store.db.prepare('SELECT state FROM whatsapp_onboarding_flows WHERE id=?').get(flow.requestId).state,'interrupted');
  const prior=slot(legacy),h=p.make(undefined,capable(p)),next=modeCommand(p,'coexistence');
  await assert.rejects(p.prepare(next,h),{code:'idempotency_conflict'});
  await p.execute({...cmd,requestId:randomUUID(),operation:C.OPERATIONS.abort,payload:{flowId:flow.requestId}},legacy);
  const prepared=await p.prepare(next,h),current=slot(h);
  assert.equal(prepared.data.binding.customer.providerGrantPolicy,C.PROVIDER_GRANT_POLICY);
  assert.equal(current.provider_grant_policy,C.PROVIDER_GRANT_POLICY);
  for(const key of ['arn','name','version_id','config_digest','created_at'])assert.equal(current[key],prior[key]);
  assert.equal(p.f.state.codes,1);assert.equal(p.f.state.puts,0);assert.equal(p.state.creates,1);
});
test('Retained flow states, candidate evidence, authorities and preparations prevent profile rewrites',async t=>{
  for(const condition of ['awaiting','exchanging','staging','staged','interrupted','aborted_candidate','activation','reservation','preparation','inflight'])await t.test(condition,async t=>{
    const p=provisioningFixture(t),legacy=p.make(undefined,profile(p)),cmd=p.command();await p.prepare(cmd,legacy);
    const original=slot(legacy),flow=await begin(p,legacy,cmd);
    legacy.store.db.prepare("UPDATE whatsapp_onboarding_flows SET state='aborted' WHERE id=?").run(flow.requestId);
    if(['awaiting','exchanging','staging','staged','interrupted'].includes(condition))legacy.store.db.prepare('UPDATE whatsapp_onboarding_flows SET state=? WHERE id=?').run(condition,flow.requestId);
    if(condition==='aborted_candidate')legacy.store.db.prepare('UPDATE whatsapp_onboarding_flows SET secret_digest=? WHERE id=?').run('a'.repeat(64),flow.requestId);
    if(condition==='activation'){
      legacy.store.db.exec('CREATE TABLE whatsapp_activations(flow_id TEXT,definition TEXT)');
      legacy.store.db.prepare('INSERT INTO whatsapp_activations VALUES (?,?)').run(randomUUID(),JSON.stringify({enrollmentBinding:{connectionRef:cmd.connectionRef,whatsappOnboarding:{scopeKey:cmd.payload.scopeKey}}}));
    }
    if(condition==='reservation')legacy.store.db.prepare('INSERT INTO whatsapp_onboarding_wabas VALUES (?,?,?,?,?,?,?,?)').run('301',cmd.connectionRef,cmd.tenantRef,cmd.assetRef,cmd.payload.scopeDigest,cmd.payload.clinicSetDigest,flow.requestId,p.f.now());
    if(condition==='preparation')legacy.store.db.prepare('INSERT INTO whatsapp_preparation_requests VALUES (?,?,?,?,NULL)').run(randomUUID(),'b'.repeat(64),cmd.payload.scopeKey,p.f.now());
    if(condition==='inflight')legacy.store.db.prepare('INSERT INTO commands VALUES (?,?,?,?,NULL,?)').run('gateway:whatsapp-onboarding',randomUUID(),'c'.repeat(64),'started',p.f.now());
    const h=p.make(undefined,capable(p));await assert.rejects(p.prepare(modeCommand(p,'coexistence'),h),{code:'idempotency_conflict'});
    assert.deepEqual(slot(h),original);assert.equal(p.state.creates,1);assert.equal(p.f.state.codes,0);
  });
});
test('Concurrent different modes never change the winner and identical replays create only one empty slot',async t=>{
  const p=provisioningFixture(t),h=p.make(undefined,capable(p)),other=p.make(undefined,capable(p));
  const coex=modeCommand(p,'coexistence'),cloud=modeCommand(p,'cloud_api');
  const outcomes=await Promise.allSettled([p.prepare(coex,h),p.prepare(cloud,other)]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(r=>r.status==='rejected'&&r.reason.code==='idempotency_conflict').length,1);
  const winner=outcomes[0].status==='fulfilled'?coex:cloud;
  const before=slot(h);await p.prepare(winner,h);assert.deepEqual(slot(h),before);assert.equal(p.state.creates,1);
  const changed=structuredClone(winner);changed.payload.mode=winner.payload.mode==='coexistence'?'cloud_api':'coexistence';
  await assert.rejects(p.prepare(changed,h),{code:'idempotency_conflict'});
});
test('A begin resolved before another process selects the slot profile cannot persist a stale fingerprint',async t=>{
  const p=provisioningFixture(t),legacy=p.make(undefined,profile(p)),cmd=p.command();await p.prepare(cmd,legacy);
  const stale=legacy.provisioner.resolveBinding(cmd.connectionRef);
  const current=p.make(undefined,capable(p));await p.prepare(modeCommand(p,'coexistence'),current);
  const value={...cmd,requestId:randomUUID(),operation:C.OPERATIONS.begin,payload:{
    state:randomBytes(32).toString('base64url'),expiresAt:p.f.now()+600000,
    scopeDigest:cmd.payload.scopeDigest,clinicSetDigest:cmd.payload.clinicSetDigest}};
  await assert.rejects(legacy.engine.operations[C.OPERATIONS.begin].execute({request:value,
    principal:p.f.policy.principals[0],binding:stale,policy:p.f.policy}),{code:'idempotency_conflict'});
  assert.equal(current.store.db.prepare('SELECT count(*) AS n FROM whatsapp_onboarding_flows').get().n,0);
  assert.equal(p.f.state.codes,0);assert.equal(p.f.state.puts,0);
  assert.equal((await p.execute(value,current)).data.status,'awaiting');
});
test('Modern coexistence preparation without a server capability never creates a sticky strict slot',async t=>{
  const p=provisioningFixture(t),legacy=p.make(undefined,profile(p));
  await assert.rejects(p.prepare(modeCommand(p,'coexistence'),legacy),{code:'invalid_request'});
  assert.equal(slot(legacy),undefined);assert.equal(p.state.creates,0);
  const override=p.make(undefined,{...profile(p),grantPolicyOverrides:[{scopeKey:'clinic:123',policy:C.PROVIDER_GRANT_POLICY}]});
  assert.equal((await p.prepare(modeCommand(p,'coexistence'),override)).data.binding.customer.providerGrantPolicy,C.PROVIDER_GRANT_POLICY);
});
test('Selecting a virgin profile cannot clear revocation or affect another legacy authority',async t=>{
  const p=provisioningFixture(t),legacy=p.make(undefined,profile(p)),old=p.command('clinic:124',[124]);
  await p.prepare(old,legacy);const flow=await begin(p,legacy,old),before=slot(legacy,'clinic:124');
  const fingerprint=C.fingerprint(legacy.provisioner.resolveBinding(old.connectionRef));
  const h=p.make(undefined,capable(p));await p.prepare(modeCommand(p,'coexistence'),h);
  assert.deepEqual(slot(h,'clinic:124'),before);assert.equal(C.fingerprint(h.provisioner.resolveBinding(old.connectionRef)),fingerprint);
  assert.equal(h.store.db.prepare('SELECT state FROM whatsapp_onboarding_flows WHERE id=?').get(flow.requestId).state,'awaiting');
  h.store.db.prepare('INSERT INTO whatsapp_onboarding_scope_blocks VALUES (?,?,?,?)').run('clinic:125',P.connectionRef('clinic:125'),randomUUID(),p.f.now());
  await assert.rejects(p.prepare(modeCommand(p,'coexistence','clinic:125',[125]),h),{code:'asset_revoked'});
  assert.equal(slot(h,'clinic:125'),undefined);
});
