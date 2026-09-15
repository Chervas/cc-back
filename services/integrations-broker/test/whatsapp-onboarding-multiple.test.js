'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { fixture, TOKEN } = require('./whatsapp-onboarding-fixture.cjs');
const C = require('../src/whatsapp-onboarding-contract'); const A = require('../src/whatsapp-authorized-contract');
const { createWhatsappAuthorizedRegistry } = require('../src/whatsapp-authorized-registry');
const { createWhatsappAuthorizedSecrets } = require('../src/whatsapp-authorized-secrets');
const { ACCOUNT, SECRET_KEY } = require('../src/google-main');
function setup(t) {
  const f=fixture(t,{customer:{selectionOnly:true}});
  f.state.afterGraph=(req,response)=>req.action==='phones'?{data:[{id:'401'},{id:'402'}]}:response;
  return f;
}
const row=(f,flow)=>f.current.store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(flow.flowId);
const candidate=(f,flow)=>f.records.get(f.binding.secretArn).get(flow.flowId);
function definition(f,flow,phoneId,enabled=false){return {connectionRef:'connection:operational-'+phoneId,authorizationId:flow.flowId,enabled,
  enrollmentBinding:structuredClone(f.binding),phoneId,wabaId:'301',candidateDigest:row(f,flow).secret_digest,expiresAt:f.now()+3600000,templates:[]};}
const binding=d=>({connectionRef:d.connectionRef,provider:A.PROVIDER,initialState:'active',expiresAt:d.expiresAt});
function reader(t,f,definitions){
  const registry=createWhatsappAuthorizedRegistry({filename:f.filename,authorizations:definitions,loadEnrollmentBinding:()=>f.binding,now:f.now});
  const secrets=createWhatsappAuthorizedSecrets({client:f.aws,accountId:ACCOUNT,prefix:'/clinicaclick/integrations/prod/',kmsKeyArn:SECRET_KEY,registry,http:f.http,now:f.now});
  t.after(()=>{secrets.close();registry.close();});return {registry,secrets};
}
test('Primary and secondary stage in the same slot without changing primary, assignment reservations or enabling sends',async t=>{
  const f=setup(t), first=await f.begin({channelRole:'primary'}); await f.finish(first);
  const prior={row:{...row(f,first)},body:candidate(f,first).body,slot:structuredClone(f.records.get(f.binding.secretArn).get(f.binding.whatsappOnboarding.slotVersionId))};
  const second=await f.begin({channelRole:'secondary'}); await f.finish(second,{phoneId:'402'});
  assert.deepEqual({...row(f,first)},prior.row); assert.equal(candidate(f,first).body,prior.body);
  assert.deepEqual(f.records.get(f.binding.secretArn).get(f.binding.whatsappOnboarding.slotVersionId),prior.slot);
  assert.deepEqual(candidate(f,first).stages,[]);assert.deepEqual(candidate(f,second).stages,['AWSPENDING']);
  assert.equal(JSON.parse(candidate(f,first).body).channelRole,'primary');assert.equal(JSON.parse(candidate(f,second).body).channelRole,'secondary');
  assert.deepEqual(f.current.store.db.prepare('SELECT phone_id,connection,asset,tenant FROM whatsapp_onboarding_assets ORDER BY phone_id').all().map(v=>({...v})),
    ['401','402'].map(phone_id=>({phone_id,connection:f.binding.connectionRef,asset:'wa-enroll:group:9',tenant:'clinic:71'})));
  f.restart();for(const [flow,role] of [[first,'primary'],[second,'secondary']]){const result=(await f.status(flow)).data;
    assert.equal(result.status,'staged');assert.equal(result.channelRole,role);assert.equal(result.connected,false);assert.equal(result.accessBlocked,false);}
  const disabled=reader(t,f,[definition(f,first,'401'),definition(f,second,'402')]); const calls=[f.state.awsCalls.length,f.state.httpCalls.length];
  for(const def of [definition(f,first,'401'),definition(f,second,'402')])await assert.rejects(disabled.secrets.withSecret(binding(def),()=>assert.fail('paused callback')),{code:'connection_blocked'});
  assert.deepEqual([f.state.awsCalls.length,f.state.httpCalls.length],calls);
  // Fixture-only callback verifies both exact versions; no Graph send exists in this fixture.
  const definitions=[definition(f,first,'401',true),definition(f,second,'402',true)],r=reader(t,f,definitions);
  f.state.afterAws=(command,result)=>{if(command.constructor.name==='GetSecretValueCommand' && command.input.VersionId===first.flowId)delete result.VersionStages;return result;};
  for(const def of definitions) assert.deepEqual(await r.secrets.withSecret(binding(def),secret=>{assert.equal(secret.toString(),TOKEN);return {verified:true};}),{verified:true});
  await f.abort(second); assert.equal((await f.status(first)).data.status,'staged');
  assert.equal(r.registry.assert(binding(definitions[0])).definition.phoneId,'401');
  assert.throws(()=>r.registry.assert(binding(definitions[1])),{code:'scope_denied'});
  assert.equal(candidate(f,first).body,prior.body);assert.equal(f.state.puts,2);assert.equal(f.state.codes,2);
  assert(f.state.httpCalls.every(call=>['inspect','waba_owner','phones','phone_state'].includes(call.action)));
});
test('Overlapping awaiting, exchanging and unacknowledged staging still exclude another flow',async t=>{
  for(const state of ['awaiting','exchanging','staging']){
    const f=setup(t),first=await f.begin({channelRole:'primary'});
    if(state==='exchanging')f.current.store.db.prepare("UPDATE whatsapp_onboarding_flows SET state='exchanging' WHERE id=?").run(first.flowId);
    if(state==='staging'){f.state.losePut=true;await assert.rejects(f.finish(first),{code:'secret_unavailable'});}
    const before={...row(f,first)},counts=[f.state.codes,f.state.puts];
    await assert.rejects(f.begin({channelRole:'secondary'}),{code:'oauth_flow_busy'});
    assert.deepEqual({...row(f,first)},before);assert.deepEqual([f.state.codes,f.state.puts],counts);
  }
});
test('Role replay, altered phone callback and reused authorization code cannot retarget an existing attempt',async t=>{
  const f=setup(t),first=await f.begin({channelRole:'primary'}); await f.finish(first);
  const next=await f.begin({channelRole:'secondary'});
  await assert.rejects(f.execute(C.OPERATIONS.begin,{...next.payload,channelRole:'primary'},{requestId:next.flowId}),{code:'idempotency_conflict'});
  await f.finish(next,{phoneId:'402'});
  await assert.rejects(f.finish(next,{phoneId:'401'}),{code:'idempotency_conflict'});
  const third=await f.begin({channelRole:'secondary'});
  await assert.rejects(f.finish(third,{code:next.code,phoneId:'402'}),{code:'idempotency_conflict'});
  await f.abort(third);assert.equal((await f.status(first)).data.status,'staged');assert.equal((await f.status(next)).data.status,'staged');
  assert.equal(f.state.codes,2);assert.equal(f.state.puts,2);
});
test('Secondary role is bound inside candidate digest and cannot be downgraded through the ledger',async t=>{
  const f=setup(t),flow=await f.begin({channelRole:'secondary'});await f.finish(flow,{phoneId:'402'});
  const def=definition(f,flow,'402',true),r=reader(t,f,[def]); const bytes=candidate(f,flow).body;
  for(const value of ['primary',null]){
    f.current.store.db.prepare('UPDATE whatsapp_onboarding_flows SET channel_role=? WHERE id=?').run(value,flow.flowId);
    const before=f.state.httpCalls.length;
    await assert.rejects(r.secrets.withSecret(binding(def),()=>assert.fail('tampered intent callback')),{code:'secret_unavailable'});
    assert.equal(f.state.httpCalls.length,before);assert.equal(candidate(f,flow).body,bytes);
  }
});
test('Nullable SQLite upgrade preserves old rows, immutable candidate bytes and readonly operational compatibility',async t=>{
  const f=setup(t),flow=await f.begin();await f.finish(flow);const old=candidate(f,flow).body;
  assert.equal(Object.hasOwn(JSON.parse(old),'channelRole'),false);
  f.current.store.db.exec('ALTER TABLE whatsapp_onboarding_flows DROP COLUMN channel_role');
  const def=definition(f,flow,'401',true),r=reader(t,f,[def]);
  assert.deepEqual(await r.secrets.withSecret(binding(def),()=>({ok:true})),{ok:true});
  f.restart();assert.equal(row(f,flow).channel_role,null);assert.equal(candidate(f,flow).body,old);
  assert.deepEqual(await r.secrets.withSecret(binding(def),()=>({ok:true})),{ok:true});
  assert.equal(Object.hasOwn((await f.status(flow)).data,'channelRole'),false);assert.equal(f.state.puts,1);assert.equal(f.state.codes,1);
});
