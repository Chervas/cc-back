'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture,TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs'),C=require('../src/meta-marketing-oauth-contract'),E=require('../src/meta-marketing-enrollment-contract'),M=require('../src/meta-marketing-contract');
const runtime=require('../src/meta-marketing-oauth-main');
const REFS=['meta-ad_account:301','meta-facebook_page:401','meta-instagram_business:501'];
async function ready(t,refs=REFS){
  const f=fixture(t,{enrollment:true}),flow=await f.begin(),staged=await f.finish(flow),id=randomUUID();
  const payload={enrollmentId:id,flowId:flow.flowId,scopeDigest:flow.payload.scopeDigest,candidateDigest:staged.data.candidate.digest,assetRefs:refs};
  const prepare=(changes={},options={})=>f.execute(E.OPERATIONS.prepare,{...payload,...changes},options);
  const activate=(receipt,options={})=>f.execute(E.OPERATIONS.activate,{enrollmentId:id,scopeDigest:payload.scopeDigest,selectionDigest:receipt.selectionDigest},options);
  const status=()=>f.execute(E.OPERATIONS.status,{enrollmentId:id});
  const revoke=()=>f.execute(E.OPERATIONS.revoke,{enrollmentId:id},{},true);
  const read=(ref=REFS[0],operation=M.ASSET,role='reader')=>f.execute(operation,{}, {assetRef:ref},role);
  return {f,flow,id,payload,prepare,activate,status,revoke,read};
}
const rows=f=>f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments').all();
test('selection, activation and all three typed reads use the same candidate; no secret write, policy expansion or business operation',async t=>{
  const r=await ready(t),{f}=r,policy=JSON.stringify(f.current.broker.policy),before=f.state.awsCalls.length,graph=f.state.httpCalls.length;
  const prepared=(await r.prepare()).data;assert.equal(prepared.status,'prepared');assert.equal(prepared.accessBlocked,true);assert.equal(prepared.assets.length,3);
  await assert.rejects(r.read(),{code:'scope_denied'});
  const activated=(await r.activate(prepared)).data;assert.equal(activated.status,'active');assert.equal(activated.accessBlocked,false);
  assert.equal((await r.read(REFS[0])).data.id,'act_301');assert.equal((await r.read(REFS[1])).data.id,'401');assert.equal((await r.read(REFS[2])).data.id,'501');
  const status=(await r.read(REFS[0],M.STATUS)).data;assert.equal(status.assetAccessVerified,false);assert.equal(status.credentialValid,true);
  assert.equal(JSON.stringify(f.current.broker.policy),policy);assert.equal(f.state.codes,1);assert.equal(f.state.puts,1);
  assert(!f.state.awsCalls.slice(before).some(c=>['PutSecretValueCommand','ListSecretVersionIdsCommand'].includes(c.constructor.name)));
  const snapshot=JSON.stringify([rows(f),f.current.store.db.prepare('SELECT * FROM commands').all(),f.current.store.db.prepare('SELECT event FROM audit_outbox').all()]);
  for(const secret of [TOKEN,APP,r.flow.code,r.flow.payload.state])assert(!snapshot.includes(secret));
  const sample={secretCalls:f.state.awsCalls.length-before,graphCalls:f.state.httpCalls.length-graph,selected:3};t.diagnostic(JSON.stringify(sample));
});
test('runtime opt-in requires four independent roles and exact enrollment grants; old OAuth config remains valid',t=>{
  const f=fixture(t,{enrollment:true});runtime.validateConfig(f.config);const old=fixture(t);runtime.validateConfig(old.config);
  for(const change of [c=>c.assetDiscovery=false,c=>c.assetEnrollment='true',c=>c.policy.principals.pop(),c=>c.policy.principals[2].publicKey=c.policy.principals[0].publicKey,
    c=>c.policy.grants.push({...c.policy.grants[0],principalId:'staging:meta-marketing',operations:[M.ASSET]}),
    c=>c.policy.grants[0].operations=c.policy.grants[0].operations.filter(v=>v!==E.OPERATIONS.activate),c=>c.policy.grants[1].operations.push(E.OPERATIONS.prepare)]){
    const config=structuredClone(f.config);change(config);assert.throws(()=>runtime.validateConfig(config),{code:'invalid_request'});
  }
});
test('reader and asset control cannot select/activate; OAuth/control cannot read, and unknown assets cannot be revoked',async t=>{
  const r=await ready(t),{f}=r,p=(await r.prepare()).data;await r.activate(p);const before=f.state.awsCalls.length;
  for(const role of ['reader','assetControl',true])await assert.rejects(f.execute(E.OPERATIONS.prepare,r.payload,{},role),{code:'scope_denied'});
  for(const role of [false,true,'assetControl'])await assert.rejects(r.read(REFS[0],M.ASSET,role),{code:'scope_denied'});
  await assert.rejects(r.read('meta-ad_account:999',M.REVOKE,'assetControl'),{code:'scope_denied'});
  assert.equal(f.state.awsCalls.length,before);assert.equal(f.current.store.db.prepare('SELECT COUNT(*) n FROM asset_revocations').get().n,0);
});
test('selection payload cannot inject rights, identity or duplicate assets; unavailable inventory never creates partial claims',async t=>{
  const r=await ready(t),{f}=r;
  for(const change of [{assetRefs:[REFS[0],REFS[0]]},{assetRefs:[]},{assetRefs:['meta-whatsapp:301']},{readOperations:[M.ASSET]},{token:TOKEN}])await assert.rejects(r.prepare(change),{code:'invalid_request'});
  await assert.rejects(r.prepare({assetRefs:[REFS[0],'meta-ad_account:999']}),{code:'scope_denied'});
  assert.equal(rows(f).length,0);assert.equal(f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_enrollment_claims').get().n,0);
});
test('selection is immutable and one flow cannot register twice; activation checks the exact scope and digest',async t=>{
  const r=await ready(t),{f}=r,p=(await r.prepare()).data,before=f.state.awsCalls.length;
  await assert.rejects(r.prepare({assetRefs:[REFS[0]]}),{code:'idempotency_conflict'});
  await assert.rejects(r.prepare({enrollmentId:randomUUID()}),{code:'scope_denied'});
  for(const change of [{selectionDigest:'a'.repeat(64)},{scopeDigest:'b'.repeat(64)}])await assert.rejects(f.execute(E.OPERATIONS.activate,{enrollmentId:r.id,scopeDigest:r.payload.scopeDigest,selectionDigest:p.selectionDigest,...change}),{code:'idempotency_conflict'});
  assert.equal(f.state.awsCalls.length,before);assert.equal(rows(f)[0].state,'prepared');
});
test('activation repeats provider verification; a missing selected asset or changed Instagram parent does not activate',async t=>{
  for(const mutation of ['missing','parent']){
    const r=await ready(t),p=(await r.prepare()).data;
    r.f.state.afterGraph=(kind,value)=>{if(kind==='accounts'){
      if(mutation==='missing')delete value.data[0].instagram_business_account;
      else value.data=[{...value.data[0],id:'402'}];
    }return value;};
    await assert.rejects(r.activate(p),{code:'scope_denied'});assert.equal(rows(r.f)[0].state,'prepared');await assert.rejects(r.read(),{code:'scope_denied'});
  }
});
test('committed prepare/activation receipts survive lost delivery and restart without another code or token write',async t=>{
  const r=await ready(t),prepareId=randomUUID(),p=(await r.prepare({}, {requestId:prepareId})).data,activateId=randomUUID();
  await r.activate(p,{requestId:activateId});const calls=r.f.state.awsCalls.length;r.f.restart();
  assert.equal((await r.prepare({}, {requestId:prepareId})).replayed,true);
  const again=await r.activate(p,{requestId:activateId});assert.equal(again.replayed,true);assert.equal(again.data.status,'active');assert.equal(r.f.state.awsCalls.length,calls);
  assert.equal((await r.status()).data.status,'active');assert.equal((await r.read()).data.id,'act_301');assert.equal(r.f.state.codes,1);assert.equal(r.f.state.puts,1);
  await assert.rejects(r.prepare({assetRefs:[REFS[0]]},{requestId:prepareId}),{code:'idempotency_conflict'});
});
test('audit completion failure rolls back selection and activation together; uncertain request is reconciled without replaying code',async t=>{
  const r=await ready(t),store=r.f.current.store,append=store.appendAudit.bind(store);let reason='meta_enrollment_prepare_completed';
  store.appendAudit=event=>{if(event.reason===reason)throw Error('FICTITIOUS_AUDIT_FAILURE');return append(event);};
  const first=randomUUID();await assert.rejects(r.prepare({}, {requestId:first}));assert.equal(rows(r.f).length,0);
  await assert.rejects(r.prepare({}, {requestId:first}),{code:'outcome_unknown'});assert.equal((await r.status()).data.status,'not_found');
  reason='meta_enrollment_activate_completed';const p=(await r.prepare()).data;await assert.rejects(r.activate(p));assert.equal(rows(r.f)[0].state,'prepared');
  reason=null;await r.activate(p);assert.equal((await r.read()).data.id,'act_301');assert.equal(r.f.state.codes,1);
});
test('live grant and key withdrawal during provider I/O prevent selection and disclosure',async t=>{
  for(const mutation of ['grant','key','binding']){
    const r=await ready(t),{f}=r;
    f.state.afterGraph=(kind,value)=>{if(kind==='adaccounts'){
      const policy=f.current.broker.policy;
      if(mutation==='grant')policy.grants[0].operations=policy.grants[0].operations.filter(v=>v!==E.OPERATIONS.prepare);
      else if(mutation==='key')policy.principals[0].enabled=false;
      else policy.connections[0].metaMarketingOAuth.clinicIds=[71,72,73];
    }return value;};
    await assert.rejects(r.prepare(),{code:'scope_denied'});assert.equal(rows(f).length,0);assert(!f.state.httpCalls.some(v=>v.kind==='accounts'));
  }
});
test('control can cancel an in-flight selection before it exists, without claiming or globally revoking unknown assets',async t=>{
  const r=await ready(t),{f}=r;let called=false,controlCalls;
  f.state.afterGraph=async(kind,value)=>{if(kind==='adaccounts'&&!called){called=true;const before=f.state.awsCalls.length;await r.revoke();controlCalls=f.state.awsCalls.length-before;}return value;};
  await assert.rejects(r.prepare(),{code:'provider_timeout'});assert.equal(controlCalls,0);assert.equal(rows(f)[0].state,'revoked');
  assert.equal(f.current.store.db.prepare('SELECT COUNT(*) n FROM asset_revocations').get().n,0);
  assert.equal(f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_enrollment_claims').get().n,0);
  f.state.afterGraph=null;f.restart();await assert.rejects(r.prepare(),{code:'asset_revoked'});
});
test('OAuth abort interrupts an active read and blocks all future reads while status/control remain local',async t=>{
  const r=await ready(t),{f}=r,p=(await r.prepare()).data;await r.activate(p);let called=false,controlCalls;
  f.state.afterGraph=async(kind,value)=>{if(kind==='asset_ad_account'&&!called){called=true;const before=f.state.awsCalls.length;await f.abort(r.flow,f.current,true);controlCalls=f.state.awsCalls.length-before;}return value;};
  await assert.rejects(r.read(),{code:'provider_timeout'});assert.equal(controlCalls,0);f.state.afterGraph=null;f.restart();
  const before=f.state.awsCalls.length;assert.equal((await r.status()).data.accessBlocked,true);await assert.rejects(r.read(),{code:'scope_denied'});assert.equal(f.state.awsCalls.length,before);
});
test('asset withdrawal is durable across restart and cannot be cleared by a new local active state',async t=>{
  const r=await ready(t),p=(await r.prepare()).data;await r.activate(p);const before=r.f.state.awsCalls.length;
  assert.equal((await r.read(REFS[0],M.REVOKE,'assetControl')).data.revoked,true);assert.equal(r.f.state.awsCalls.length,before);r.f.restart();
  r.f.current.store.db.prepare("UPDATE meta_marketing_enrollments SET state='active'").run();
  await assert.rejects(r.read(),{code:'asset_revoked'});await assert.rejects(r.activate(p),{code:'asset_revoked'});
  assert.equal((await r.status()).data.accessBlocked,true);
});
test('credential expiry, revocation, lost granularity and mismatched identity fail active reads with no returned metadata',async t=>{
  for(const mutation of ['expiry','revoked','granular','subject']){
    const r=await ready(t),p=(await r.prepare()).data;await r.activate(p);
    if(mutation==='expiry')r.f.state.clock+=3601000;
    else r.f.state.afterGraph=(kind,v)=>{if(kind==='inspect'){
      if(mutation==='revoked')v.data.is_valid=false;
      if(mutation==='granular')v.data.granular_scopes[0].target_ids=[];
      if(mutation==='subject')v.data.user_id='999';
    }return v;};
    await assert.rejects(r.read());
  }
});
test('reader key change or physical parent revocation during an Instagram read suppresses the result',async t=>{
  for(const mutation of ['key','parent']){
    const r=await ready(t),p=(await r.prepare()).data;await r.activate(p);let changed=false;
    r.f.state.afterGraph=async(kind,value)=>{if(kind==='asset_instagram_business'&&!changed){changed=true;
      if(mutation==='key')r.f.current.broker.policy.principals.find(v=>v.id==='staging:meta-marketing').keyId='changed-key';
      else await r.read(REFS[1],M.REVOKE,'assetControl');
    }return value;};
    await assert.rejects(r.read(REFS[2]),{code:mutation==='key'?'scope_denied':'provider_timeout'});
  }
});
test('two authorized scopes cannot concurrently claim the same physical assets or their Instagram parent',async t=>{
  const r=await ready(t),{f}=r,second=structuredClone(f.binding);
  second.connectionRef='connection:meta-enroll-qa-two';second.secretArn=second.secretArn.replace('qa-candidate-','qa-second-');
  second.metaMarketingOAuth.scopeKey='group:10';second.metaMarketingOAuth.clinicIds=[81,82];
  f.records.set(second.secretArn,new Map([[second.metaMarketingOAuth.slotVersionId,{stages:['AWSCURRENT'],body:JSON.stringify({version:1,provider:'meta-marketing-oauth-slot',
    connectionRef:second.connectionRef,scopeKey:'group:10',clinicSetDigest:C.clinicDigest(second.metaMarketingOAuth),appId:'101'})}]]));
  f.policy.connections.push(second);
  const scope={connectionRef:second.connectionRef,assetRef:'meta-enroll:group:10',tenantRef:'clinic:81'};
  f.policy.grants.push(...f.policy.grants.slice(0,2).map(g=>({...structuredClone(g),...scope})));f.restart();runtime.validateConfig(f.config);
  const flow=randomUUID(),state='A'.repeat(43),scopeDigest=C.hash('second-scope');
  await f.execute(C.OPERATIONS.begin,{state,scopeDigest,clinicSetDigest:C.clinicDigest(second.metaMarketingOAuth),expiresAt:f.now()+600000},{...scope,requestId:flow});
  const candidate=(await f.execute(C.OPERATIONS.finish,{flowId:flow,state,code:'FICTITIOUS_SECOND_CODE'},scope)).data.candidate;
  let count=0,release;const barrier=new Promise(resolve=>{release=resolve;});
  f.state.afterGraph=async(kind,value)=>{if(kind==='accounts'){if(++count===2)release();await barrier;}return value;};
  const outcomes=await Promise.allSettled([r.prepare(),f.execute(E.OPERATIONS.prepare,{enrollmentId:randomUUID(),flowId:flow,scopeDigest,candidateDigest:candidate.digest,assetRefs:[REFS[2]]},scope)]);
  assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);assert.equal(outcomes.filter(v=>v.status==='rejected').length,1);assert.equal(rows(f).length,1);
  const owner=rows(f)[0];assert.equal(f.current.store.db.prepare('SELECT enrollment FROM meta_marketing_enrollment_claims WHERE asset=?').get(REFS[1]).enrollment,owner.id);
  await assert.rejects(f.execute(E.OPERATIONS.status,{enrollmentId:owner.id},owner.scope==='meta-enroll:group:9'?scope:{}),{code:'scope_denied'});
});
test('slot/app changes after the provider and failed read-result audit do not disclose or activate',async t=>{
  for(const mutation of ['pin','audit']){
    const r=await ready(t),p=(await r.prepare()).data;
    if(mutation==='pin'){
      let done=false;r.f.state.afterGraph=(kind,value)=>{if(kind==='accounts'&&!done){done=true;
        r.f.records.get(r.f.binding.clientSecretArn).get(r.f.binding.metaMarketingOAuth.appVersionId).stages=[];
      }return value;};
      await assert.rejects(r.activate(p),{code:'secret_version_changed'});assert.equal(rows(r.f)[0].state,'prepared');
    }else{
      await r.activate(p);const store=r.f.current.store,append=store.appendAudit.bind(store);
      store.appendAudit=event=>{if(event.reason==='meta_enrollment_read_completed')throw Error('FICTITIOUS_AUDIT_FAILURE');return append(event);};
      await assert.rejects(r.read());assert.equal(store.db.prepare("SELECT COUNT(*) n FROM commands WHERE state='unknown'").get().n,1);
    }
  }
});
test('an unlabelled candidate or a label moved during activation cannot become active or return a read',async t=>{
  for(const phase of ['before','during','read']){
    const r=await ready(t),p=(await r.prepare()).data,version=r.f.records.get(r.f.binding.secretArn).get(r.flow.flowId);
    if(phase==='read'){await r.activate(p);version.stages=[];await assert.rejects(r.read(),{code:'secret_version_changed'});}
    else{
      if(phase==='before')version.stages=[];
      else r.f.state.afterGraph=(kind,value)=>{if(kind==='accounts')version.stages=[];return value;};
      await assert.rejects(r.activate(p),{code:'secret_version_changed'});assert.equal(rows(r.f)[0].state,'prepared');
    }
  }
});
test('missing claims fail closed and revocation checks use the physical-asset index',async t=>{
  const r=await ready(t),p=(await r.prepare()).data;await r.activate(p);const db=r.f.current.store.db;
  const plan=db.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM asset_revocations WHERE asset IN (?,?,?) LIMIT 1').all(...REFS);
  assert(plan.some(v=>v.detail.includes('meta_marketing_revoked_asset')));
  db.prepare('DELETE FROM meta_marketing_enrollment_claims WHERE asset=?').run(REFS[1]);
  const before=r.f.state.awsCalls.length;await assert.rejects(r.read(),{code:'scope_denied'});assert.equal(r.f.state.awsCalls.length,before);
});
