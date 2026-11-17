'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto');
const {fixture,TOKEN,APP}=require('./meta-marketing-oauth-fixture.cjs');
const C=require('../src/meta-marketing-oauth-contract');
const E=require('../src/meta-marketing-enrollment-contract'),R=require('../src/meta-marketing-credential-renewal-contract');
const V=require('../src/meta-marketing-enrollment-assets-contract');
const REFS=['meta-ad_account:301','meta-facebook_page:401'];
async function ready(t,{refs=REFS,activate=true}={}){
  const f=fixture(t,{renewal:true}),flow=await f.begin(),staged=await f.finish(flow),id=randomUUID();
  const prepare={enrollmentId:id,flowId:flow.flowId,scopeDigest:flow.payload.scopeDigest,candidateDigest:staged.data.candidate.digest,assetRefs:refs};
  const prepared=(await f.execute(E.OPERATIONS.prepare,prepare)).data;
  const grant=activate?(await f.execute(E.OPERATIONS.activate,{enrollmentId:id,scopeDigest:prepare.scopeDigest,selectionDigest:prepared.selectionDigest})).data:prepared;
  const row=()=>f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(id);
  const credential=()=>f.current.epochs.current(row(),f.binding);
  const payload=()=>{const current=credential();return {enrollmentId:id,scopeDigest:grant.scopeDigest,selectionDigest:grant.selectionDigest,
    clinicSetDigest:grant.clinicSetDigest,assetSetDigest:R.assetSetDigest(grant.assets),expectedEpoch:current.epoch,
    expectedVersionId:current.versionId,expectedCandidateDigest:current.digest};};
  const discover=(patch={},overrides={},role=false)=>f.execute(E.OPERATIONS.assets,{...payload(),...patch},overrides,role);
  const immutable=()=>JSON.stringify(['meta_marketing_enrollments','meta_marketing_enrollment_assets','meta_marketing_enrollment_claims','asset_revocations','meta_marketing_effective_credentials']
    .map(table=>f.current.store.db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()));
  async function stageRenewal(){
    const current=credential(),renewalId=randomUUID(),p={renewalId,flowId:renewalId,enrollmentId:id,expectedEpoch:current.epoch,
      expectedVersionId:current.versionId,expectedCandidateDigest:current.digest,assetSetDigest:R.assetSetDigest(grant.assets),
      scopeDigest:grant.scopeDigest,clinicSetDigest:grant.clinicSetDigest,state:randomBytes(32).toString('base64url'),expiresAt:f.now()+600000};
    await f.execute(R.OPERATIONS.begin,p);
    const staged=(await f.execute(R.OPERATIONS.finish,{renewalId,flowId:renewalId,state:p.state,code:'FICTITIOUS_ACTIVE_INVENTORY_RENEWAL_'+renewalId})).data;
    const activate=()=>f.execute(R.OPERATIONS.activate,{renewalId,enrollmentId:id,expectedEpoch:p.expectedEpoch,expectedVersionId:p.expectedVersionId,
      expectedCandidateDigest:p.expectedCandidateDigest,candidateVersionId:renewalId,candidateDigest:staged.candidate.digest});
    return {id:renewalId,activate};
  }
  const expected=()=>{const current=credential();return {enrollmentId:id,scopeKey:'group:9',scopeDigest:grant.scopeDigest,selectionDigest:grant.selectionDigest,
    clinicSetDigest:grant.clinicSetDigest,assetSetDigest:R.assetSetDigest(grant.assets),epoch:current.epoch,versionId:current.versionId,digest:current.digest,
    metadata:current.metadata,selected:grant.assets,startedAt:f.now(),now:f.now()};};
  return {f,flow,id,grant,row,credential,payload,discover,immutable,stageRenewal,expected};
}
test('active inventory returns exactly selected identities and typed metadata without claiming other provider assets',async t=>{
  const r=await ready(t),before=r.immutable(),puts=r.f.state.puts,codes=r.f.state.codes,aws=r.f.state.awsCalls.length;
  r.f.state.afterGraph=(kind,value)=>{
    if(kind==='adaccounts')value.data.push({id:'act_302',account_id:'302',name:'UNSELECTED_ACCOUNT',account_status:1,currency:'EUR',timezone_name:'Europe/Madrid'});
    if(kind==='accounts')value.data.push({id:'402',name:'UNSELECTED_PAGE',instagram_business_account:{id:'502',name:'UNSELECTED_INSTAGRAM',username:'unselected'}});
    return value;
  };
  const result=(await r.discover()).data;
  assert.deepEqual(result.assets.map(E.identity),r.grant.assets);
  assert.deepEqual(result.availableKinds,['ad_account','facebook_page']);
  assert.equal(result.enrollmentId,r.id);assert.equal(result.epoch,0);assert.equal(result.versionId,r.flow.flowId);
  assert.equal(result.expiresAt,r.f.now()+V.MAX_AGE_MS);V.validateResult(result,r.expected());
  assert(!JSON.stringify(result).includes('UNSELECTED'));assert(!Object.hasOwn(result,'candidateVersionId'));assert(!Object.hasOwn(result,'accessBlocked'));
  assert.equal(r.immutable(),before);assert.equal(r.f.state.puts,puts);assert.equal(r.f.state.codes,codes);
  assert(!r.f.state.awsCalls.slice(aws).some(call=>/Put|List|Update/.test(call.constructor.name)));
  const events=r.f.current.store.db.prepare('SELECT event FROM audit_outbox').all().map(row=>JSON.parse(row.event)).filter(event=>event.operation===E.OPERATIONS.assets);
  assert.deepEqual(events.map(event=>event.action),['integration.requested','integration.completed']);
  for(const hidden of [TOKEN,APP,'UNSELECTED',r.flow.payload.state])assert(!JSON.stringify([result,events]).includes(hidden));
});
test('epoch two inventory borrows only the effective retained flow after the original expires and AWSPENDING moves',async t=>{
  const r=await ready(t);r.f.state.clock+=1800000;
  const one=await r.stageRenewal();await one.activate();r.f.state.clock+=1800001;
  const two=await r.stageRenewal();await two.activate();const pending=await r.stageRenewal();
  const current=r.credential();assert.equal(current.epoch,2);assert.equal(current.versionId,two.id);
  assert(JSON.parse(r.f.current.store.db.prepare('SELECT credential_metadata FROM meta_marketing_oauth_flows WHERE id=?').get(r.flow.flowId).credential_metadata).expiresAt<r.f.now());
  const record=r.f.records.get(r.f.binding.secretArn);record.delete(r.flow.flowId);record.delete(one.id);
  assert(record.get(pending.id).stages.includes('AWSPENDING'));
  const before=r.immutable(),aws=r.f.state.awsCalls.length,puts=r.f.state.puts,codes=r.f.state.codes;
  const result=(await r.discover()).data;
  assert.equal(result.epoch,2);assert.equal(result.versionId,two.id);assert.equal(result.digest,current.digest);
  const versions=r.f.state.awsCalls.slice(aws).filter(call=>call.constructor.name==='GetSecretValueCommand'&&call.input.SecretId===r.f.binding.secretArn).map(call=>call.input.VersionId);
  assert(versions.includes(two.id));assert(versions.every(version=>[two.id,r.f.binding.metaMarketingOAuth.slotVersionId].includes(version)));
  assert(!versions.includes(r.flow.flowId));assert(!versions.includes(one.id));assert(!versions.includes(pending.id));
  assert.equal(r.immutable(),before);assert.equal(r.f.state.puts,puts);assert.equal(r.f.state.codes,codes);
  r.f.restart();assert.equal((await r.discover()).data.versionId,two.id);
});
test('active pins and closed payload prevent stale or foreign discovery before Secrets and Graph I/O',async t=>{
  const r=await ready(t),before=r.immutable();
  for(const patch of [{expectedEpoch:1},{expectedVersionId:randomUUID()},{expectedCandidateDigest:'a'.repeat(64)},
    {scopeDigest:'b'.repeat(64)},{selectionDigest:'c'.repeat(64)},{clinicSetDigest:'d'.repeat(64)},{assetSetDigest:'e'.repeat(64)},
    {enrollmentId:randomUUID()},{flowId:r.flow.flowId},{assetRefs:REFS},{token:TOKEN},{scopes:['ads_read']},{expectedEpoch:-1}]){
    const aws=r.f.state.awsCalls.length,http=r.f.state.httpCalls.length;
    await assert.rejects(r.discover(patch));assert.equal(r.f.state.awsCalls.length,aws);assert.equal(r.f.state.httpCalls.length,http);
  }
  for(const role of [true,'reader','assetControl'])await assert.rejects(r.discover({}, {},role),{code:'scope_denied'});
  for(const overrides of [{tenantRef:'clinic:72'},{assetRef:'meta-ad_account:301'},{connectionRef:'connection:foreign'}])await assert.rejects(r.discover({},overrides));
  assert.equal(r.immutable(),before);
});
test('prepared, revoked and expired enrollments cannot disclose active inventory',async t=>{
  const prepared=await ready(t,{activate:false}),a=prepared.f.state.awsCalls.length;
  await assert.rejects(prepared.discover(),{code:'scope_denied'});assert.equal(prepared.f.state.awsCalls.length,a);
  const revoked=await ready(t);await revoked.f.execute(E.OPERATIONS.revoke,{enrollmentId:revoked.id},{},true);
  const b=revoked.f.state.awsCalls.length;await assert.rejects(revoked.discover(),{code:'scope_denied'});assert.equal(revoked.f.state.awsCalls.length,b);
  const expired=await ready(t);expired.f.state.clock+=3601000;
  const c=expired.f.state.awsCalls.length;await assert.rejects(expired.discover(),{code:'credential_revoked'});assert.equal(expired.f.state.awsCalls.length,c);
});
test('active discovery requires the effective-credential owner even for an initial epoch zero enrollment',async t=>{
  const f=fixture(t,{enrollment:true}),flow=await f.begin(),staged=await f.finish(flow),id=randomUUID();
  const prepared=(await f.execute(E.OPERATIONS.prepare,{enrollmentId:id,flowId:flow.flowId,scopeDigest:flow.payload.scopeDigest,
    candidateDigest:staged.data.candidate.digest,assetRefs:REFS})).data;
  const grant=(await f.execute(E.OPERATIONS.activate,{enrollmentId:id,scopeDigest:prepared.scopeDigest,selectionDigest:prepared.selectionDigest})).data;
  const aws=f.state.awsCalls.length,http=f.state.httpCalls.length;
  await assert.rejects(f.execute(E.OPERATIONS.assets,{enrollmentId:id,scopeDigest:grant.scopeDigest,selectionDigest:grant.selectionDigest,
    clinicSetDigest:grant.clinicSetDigest,assetSetDigest:R.assetSetDigest(grant.assets),expectedEpoch:0,
    expectedVersionId:flow.flowId,expectedCandidateDigest:staged.data.candidate.digest}),{code:'operation_denied'});
  assert.equal(f.state.awsCalls.length,aws);assert.equal(f.state.httpCalls.length,http);
});
for(const agency of [false,true])test(`${agency?'Agency':'BISU'} active discovery preserves issuer authority beyond the initial deadline without another mint`,async t=>{
  const B=require('../src/meta-marketing-business-contract');
  const f=fixture(t,{...(agency?{agency:true}:{business:true}),migrationDays:0.01}),flow=await f.begin(),staged=await f.finish(flow),oldId=randomUUID();
  const prepared=(await f.execute(E.OPERATIONS.prepare,{enrollmentId:oldId,flowId:flow.flowId,scopeDigest:flow.payload.scopeDigest,
    candidateDigest:staged.data.candidate.digest,assetRefs:REFS})).data;
  const old=(await f.execute(E.OPERATIONS.activate,{enrollmentId:oldId,scopeDigest:prepared.scopeDigest,selectionDigest:prepared.selectionDigest})).data;
  const source=f.current.enrollment.renewalAuthority(oldId,f.binding),id=randomUUID(),p={handoverId:id,flowId:id,newEnrollmentId:id,oldEnrollmentId:oldId,
    expectedEpoch:source.credential.epoch,expectedVersionId:source.credential.versionId,expectedCandidateDigest:source.credential.digest,
    assetSetDigest:R.assetSetDigest(old.assets),oldScopeDigest:old.scopeDigest,scopeDigest:C.hash('FICTITIOUS_INVENTORY_ISSUER_'+id),
    clinicSetDigest:old.clinicSetDigest,state:randomBytes(32).toString('base64url'),expiresAt:f.now()+600000};
  await f.execute(B.OPERATIONS.begin,p);
  await f.execute(B.OPERATIONS.finish,{handoverId:id,flowId:id,state:p.state,code:(agency?'FICTITIOUS_AGENCY_CODE_':'FICTITIOUS_BUSINESS_CODE_')+id});
  let status;
  for(let attempt=0;attempt<2000;attempt++){
    const row=f.current.store.db.prepare('SELECT state FROM meta_marketing_business_handovers WHERE id=?').get(id);
    if(row?.state==='staged'){status=(await f.execute(B.OPERATIONS.status,{handoverId:id},{},true)).data;break;}
    if(['rejected','interrupted','aborted'].includes(row?.state))assert.fail('Fictitious issuer did not stage');
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert(status,'Fictitious issuer stage timed out');
  const drain=(await f.execute(B.OPERATIONS.drain,{handoverId:id},{},true)).data.drain;
  const activated=(await f.execute(B.OPERATIONS.activate,{handoverId:id,newEnrollmentId:id,oldEnrollmentId:oldId,oldGrantDigest:status.oldGrantDigest,
    expectedEpoch:p.expectedEpoch,expectedVersionId:p.expectedVersionId,expectedCandidateDigest:p.expectedCandidateDigest,
    candidateVersionId:id,candidateDigest:status.candidate.digest,drainDigest:drain.receiptSetDigest})).data.newEnrollment;
  f.state.clock=f.binding.expiresAt+1000;
  const effective=f.current.enrollment.renewalAuthority(id,f.binding),credential=effective.credential;
  const payload={enrollmentId:id,scopeDigest:activated.scopeDigest,selectionDigest:activated.selectionDigest,clinicSetDigest:activated.clinicSetDigest,
    assetSetDigest:R.assetSetDigest(activated.assets),expectedEpoch:credential.epoch,expectedVersionId:credential.versionId,expectedCandidateDigest:credential.digest};
  const before=JSON.stringify(['meta_marketing_enrollments','meta_marketing_effective_credentials','meta_marketing_enrollment_claims','meta_marketing_business_handovers']
    .map(table=>f.current.store.db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()));
  const puts=f.state.puts,codes=f.state.codes,agencyState=agency?JSON.stringify([f.state.agency.creates,f.state.agency.mints]):null;
  const result=(await f.execute(E.OPERATIONS.assets,payload)).data;
  assert.deepEqual(result.assets.map(E.identity),activated.assets);assert.deepEqual(result.availableKinds,['ad_account','facebook_page']);
  assert.equal(result.versionId,credential.versionId);assert(result.expiresAt>f.binding.expiresAt);
  V.validateResult(result,{...payload,scopeKey:'group:9',epoch:credential.epoch,versionId:credential.versionId,digest:credential.digest,
    metadata:credential.metadata,selected:activated.assets,startedAt:f.now(),now:f.now()});
  assert.equal(JSON.stringify(['meta_marketing_enrollments','meta_marketing_effective_credentials','meta_marketing_enrollment_claims','meta_marketing_business_handovers']
    .map(table=>f.current.store.db.prepare('SELECT * FROM '+table+' ORDER BY 1').all())),before);
  assert.equal(f.state.puts,puts);assert.equal(f.state.codes,codes);
  if(agency)assert.equal(JSON.stringify([f.state.agency.creates,f.state.agency.mints]),agencyState);
});
test('missing selected inventory or changed parent fails instead of exposing a smaller or different selection',async t=>{
  for(const mode of ['page','parent']){
    const r=await ready(t,{refs:[...REFS,'meta-instagram_business:501']}),before=r.immutable();
    r.f.state.afterGraph=(kind,value)=>{
      if(kind==='accounts')value.data=mode==='page'?[]:[{id:'401',name:'Selected page'},{id:'402',name:'Other page',instagram_business_account:{id:'501',name:'Moved Instagram',username:'moved'}}];
      return value;
    };
    await assert.rejects(r.discover(),{code:'scope_denied'});assert.equal(r.immutable(),before);
  }
});
test('effective credential switch during provider discovery is a version conflict with no stale result',async t=>{
  const r=await ready(t),next=await r.stageRenewal();let switched=false;
  r.f.state.afterGraph=async(kind,value)=>{if(kind==='adaccounts'&&!switched){switched=true;await next.activate();}return value;};
  await assert.rejects(r.discover(),{code:'secret_version_changed'});assert.equal(switched,true);
  r.f.state.afterGraph=null;assert.equal(r.credential().epoch,1);assert.equal((await r.discover()).data.versionId,next.id);
});
test('live principal, operation grant, scope binding and enrollment withdrawal fence provider I/O',async t=>{
  for(const mode of ['key','grant','binding','revoke']){
    const r=await ready(t);let changed=false;
    r.f.state.afterGraph=async(kind,value)=>{
      if(kind==='adaccounts'&&!changed){changed=true;
        const policy=r.f.current.broker.policy;
        if(mode==='key')policy.principals[0].enabled=false;
        else if(mode==='grant')policy.grants[0].operations=policy.grants[0].operations.filter(operation=>operation!==E.OPERATIONS.assets);
        else if(mode==='binding')policy.connections[0].metaMarketingOAuth.clinicIds=[71,72,73];
        else await r.f.execute(E.OPERATIONS.revoke,{enrollmentId:r.id},{},true);
      }return value;
    };
    await assert.rejects(r.discover());assert.equal(changed,true);
  }
});
test('provider continuation contributes only a bounded cursor and never fetches the supplied URL or discloses extras',async t=>{
  const r=await ready(t);let pages=0;
  r.f.state.afterGraph=(kind,value)=>{
    if(kind==='accounts'){
      if(pages++===0)return {data:value.data,paging:{cursors:{after:'QA_ACTIVE_CURSOR'},next:'https://foreign.invalid/private?access_token='+TOKEN}};
      assert.equal(r.f.state.lastAfter,'QA_ACTIVE_CURSOR');return {data:[{id:'402',name:'UNSELECTED_CONTINUATION'}]};
    }return value;
  };
  const result=(await r.discover()).data;
  assert.equal(pages,2);assert.deepEqual(result.assets.map(E.identity),r.grant.assets);assert(!JSON.stringify(result).includes('QA_ACTIVE_CURSOR'));
  r.f.state.afterGraph=(kind,value)=>kind==='accounts'?{data:value.data,paging:{cursors:{after:'SAME'},next:'https://foreign.invalid'}}:value;
  await assert.rejects(r.discover(),{code:'provider_failed'});
});
test('active result validator rejects substituted pins, extra assets, candidate fields, expired TTL and provider-only kinds',async t=>{
  const r=await ready(t),valid=(await r.discover()).data,expected=r.expected();
  for(const change of [value=>value.epoch++,value=>value.versionId=randomUUID(),value=>value.digest='a'.repeat(64),
    value=>value.scopeDigest='b'.repeat(64),value=>value.selectionDigest='c'.repeat(64),value=>value.clinicSetDigest='d'.repeat(64),
    value=>value.assetSetDigest='e'.repeat(64),value=>value.candidateVersionId=r.flow.flowId,
    value=>value.expiresAt=expected.now,value=>value.expiresAt=value.observedAt+V.MAX_AGE_MS+1,
    value=>value.availableKinds.push('instagram_business'),value=>value.assets.pop(),
    value=>value.assets.push({assetRef:'meta-facebook_page:402',kind:'facebook_page',id:'402',name:'Other',parentPageId:null})]){
    const value=structuredClone(valid);change(value);assert.throws(()=>V.validateResult(value,expected));
  }
  const cloned=V.validateResult(valid,expected);cloned.assets[0].name='LOCAL_CHANGE';assert.notEqual(cloned.assets[0].name,valid.assets[0].name);
});
