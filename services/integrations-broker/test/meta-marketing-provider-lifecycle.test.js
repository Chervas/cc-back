'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto');
const {fixture}=require('./meta-marketing-oauth-fixture.cjs'),C=require('../src/meta-marketing-oauth-contract'),B=require('../src/meta-marketing-business-contract'),A=require('../src/meta-marketing-agency-contract');
const E=require('../src/meta-marketing-enrollment-contract'),R=require('../src/meta-marketing-credential-renewal-contract'),T=require('../src/meta-marketing-credential-maintenance-contract'),M=require('../src/meta-marketing-contract');
async function setup(t,{four=false,migrationDays=2}={}){const f=fixture(t,{agency:true,migrationDays});if(four){f.state.extraAssets=true;f.businessConfig.bootstrap.assets.push({assetRef:'meta-ad_account:302',tasks:['ANALYZE']},{assetRef:'meta-facebook_page:402',tasks:['ADVERTISE','ANALYZE','MANAGE_LEADS']});f.state.afterGraph=(kind,v)=>{if(kind==='inspect')v.data.granular_scopes[0].target_ids.push('302');if(kind==='adaccounts')v.data.push({...v.data[0],id:'act_302',account_id:'302'});if(kind==='accounts')v.data.push({id:'402',name:'Fictitious second partner page'});return v;};}
 const flow=await f.begin(),token=await f.finish(flow),oldId=randomUUID();
 const prepared=await f.execute(E.OPERATIONS.prepare,{enrollmentId:oldId,flowId:flow.flowId,scopeDigest:flow.payload.scopeDigest,candidateDigest:token.data.candidate.digest,assetRefs:['meta-ad_account:301','meta-facebook_page:401',...(four?['meta-ad_account:302','meta-facebook_page:402']:[])]});
 await f.execute(E.OPERATIONS.activate,{enrollmentId:oldId,scopeDigest:flow.payload.scopeDigest,selectionDigest:prepared.data.selectionDigest});return {f,oldId};}
function handover(f,oldId){const id=randomUUID(),source=f.current.enrollment.renewalAuthority(oldId,f.binding),p={handoverId:id,flowId:id,newEnrollmentId:id,oldEnrollmentId:oldId,
 expectedEpoch:source.credential.epoch,expectedVersionId:source.credential.versionId,expectedCandidateDigest:source.credential.digest,assetSetDigest:R.assetSetDigest(source.assets),oldScopeDigest:source.row.scope_digest,
 scopeDigest:C.hash('FICTITIOUS_AGENCY_SCOPE_'+id),clinicSetDigest:C.clinicDigest(f.binding.metaMarketingOAuth),state:randomBytes(32).toString('base64url'),expiresAt:f.now()+600000};
 const status=()=>f.execute(B.OPERATIONS.status,{handoverId:id},{},true),start=()=>f.execute(B.OPERATIONS.begin,p),finish=()=>f.execute(B.OPERATIONS.finish,{handoverId:id,flowId:id,state:p.state,code:'FICTITIOUS_AGENCY_CODE_'+id});
 async function settled(){for(let n=0;n<2000;n++){const row=f.current.store.db.prepare('SELECT state FROM meta_marketing_business_handovers WHERE id=?').get(id);if(['staged','active','aborted','rejected','interrupted'].includes(row?.state))return status();await new Promise(resolve=>setImmediate(resolve));}assert.fail('FICTITIOUS_BACKGROUND_DID_NOT_SETTLE');}
 async function activate(){const s=await status(),d=await f.execute(B.OPERATIONS.drain,{handoverId:id},{},true);return f.execute(B.OPERATIONS.activate,{handoverId:id,newEnrollmentId:id,oldEnrollmentId:oldId,oldGrantDigest:s.data.oldGrantDigest,
 expectedEpoch:p.expectedEpoch,expectedVersionId:p.expectedVersionId,expectedCandidateDigest:p.expectedCandidateDigest,candidateVersionId:id,candidateDigest:s.data.candidate.digest,drainDigest:d.data.drain.receiptSetDigest});}
 return {id,p,start,finish,status,settled,activate,abort:()=>f.execute(B.OPERATIONS.abort,{handoverId:id},{},true)};
}
async function active(t){const r=await setup(t),h=handover(r.f,r.oldId);await h.start();await h.finish();assert.equal((await h.settled()).data.status,'staged',r.f.state.fixtureError?.message);await h.activate();return {...r,h};}
const read=f=>f.execute(M.ASSET,{},{assetRef:'meta-ad_account:301'},'reader');
function maintenance(f,id){const g=f.current.enrollment.renewalAuthority(id,f.binding),maintenanceId=randomUUID(),requestId=randomUUID(),p={maintenanceId,enrollmentId:id,expectedEpoch:g.credential.epoch,expectedVersionId:g.credential.versionId,expectedCandidateDigest:g.credential.digest};return {p,rotate:()=>f.execute(T.OPERATIONS.rotate,p,{requestId},true),status:()=>f.execute(T.OPERATIONS.status,{maintenanceId},{},true)};}


test('Meta business authority survives its immutable migration deadline and restart, while using actual current credential expiry',async t=>{
 const {f,h}=await active(t),deadline=f.binding.expiresAt;
 f.state.clock+=3*86400000;assert(f.now()>deadline);assert.equal((await read(f)).data.id,'act_301');
 assert.equal(f.current.store.connection(f.binding.connectionRef,f.now()).expires_at,deadline);
 f.state.clock+=44*86400000;const n=maintenance(f,h.id),result=await n.rotate();assert.equal(result.data.activationApplied,true);assert.equal(result.data.effectiveCredential.epoch,1);
 const flow=f.current.epochs.flowFor(n.p.maintenanceId);assert(flow.expires_at>f.now());assert(flow.expires_at>deadline);assert.equal(f.state.agency.refreshes,1);
 f.restart();assert.equal((await n.status()).data.activationApplied,true);assert.equal((await read(f)).data.id,'act_301');
 assert.equal(f.current.store.db.prepare('SELECT expires_at FROM connections WHERE ref=?').get(f.binding.connectionRef).expires_at,deadline);
});
test('an expired current business token permits fresh ordinary consent but no Ads or Page contact read before a validated replacement',async t=>{
 const {f,h}=await active(t);f.state.clock+=61*86400000;
 const puts=f.state.puts;await assert.rejects(read(f),{code:'credential_revoked'});assert.equal(f.state.puts,puts);
 const L=require('../src/meta-marketing-leads-contract');await assert.rejects(f.execute(L.OPERATIONS.form,{adAccountAssetRef:'meta-ad_account:301',formId:'801'},{assetRef:'meta-facebook_page:401'},'reader'),{code:'credential_revoked'});
 const next=handover(f,h.id),started=await next.start();assert.equal(new URL(started.data.authUrl).searchParams.get('config_id'),'778');assert(started.data.expiresAt>f.binding.expiresAt);
 await next.finish();assert.equal((await next.settled()).data.status,'staged',f.state.fixtureError?.message);await assert.rejects(read(f),{code:'credential_revoked'});
 await next.activate();assert.equal((await read(f)).data.id,'act_301');assert.equal(f.state.agency.creates,1);assert.equal(f.state.agency.installs,1);assert.equal(f.state.agency.mints,2);
});
test('initial USER and initial business migration remain deadline limited and a network flag cannot manufacture authority',async t=>{
 const f=fixture(t,{renewal:true});f.state.clock+=2*86400000;await assert.rejects(f.begin(),{code:'connection_blocked'});
 const unbound=fixture(t,{agency:true,migrationDays:2});unbound.state.clock+=3*86400000;await assert.rejects(unbound.begin(),{code:'connection_blocked'});
 const {f:g,oldId}=await setup(t),initial=handover(g,oldId);g.state.clock+=3*86400000;await assert.rejects(initial.start(),{code:'connection_blocked'});
 const {f:b,h}=await active(t);b.state.clock+=3*86400000;const n=maintenance(b,h.id);await assert.rejects(b.execute(T.OPERATIONS.rotate,{...n.p,providerLifecycle:true},{},true),{code:'invalid_request'});
 assert.equal(b.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_credential_maintenance').get().n,0);
});
test('business migration authority fails closed on absent or changed handover, activation receipt, scope/config, claims, protection and revocations',async t=>{
 const {f,h}=await active(t);f.state.clock+=3*86400000;const db=f.current.store.db;
 const mutations=[
  ()=>db.prepare("UPDATE meta_marketing_enrollments SET state='revoked' WHERE id=?").run(h.id),
  ()=>db.prepare("UPDATE meta_marketing_business_handovers SET state='staged' WHERE id=?").run(h.id),
  ()=>db.prepare('DELETE FROM meta_marketing_enrollment_successions WHERE new_enrollment=?').run(h.id),
  ()=>db.prepare("UPDATE commands SET state='unknown' WHERE id=(SELECT activation_request FROM meta_marketing_business_handovers WHERE id=?)").run(h.id),
  ()=>db.prepare("UPDATE commands SET result=replace(result,'handoverApplied\":true','handoverApplied\":false') WHERE id=(SELECT activation_request FROM meta_marketing_business_handovers WHERE id=?)").run(h.id),
  ()=>db.prepare("UPDATE meta_marketing_enrollments SET scope_digest=? WHERE id=?").run('0'.repeat(64),h.id),
  ()=>db.prepare('DELETE FROM meta_marketing_enrollment_claims WHERE asset=?').run('meta-facebook_page:401'),
  ()=>db.prepare("UPDATE meta_marketing_credential_protections SET state='intent' WHERE enrollment=?").run(h.id),
  ()=>db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:71',f.binding.connectionRef,'meta-facebook_page:401',randomUUID(),f.now()),
  ()=>db.prepare('INSERT INTO asset_revocations VALUES (?,?,?,?,?)').run('clinic:71',f.binding.connectionRef,'meta-enroll:group:9',randomUUID(),f.now()),
  ()=>db.prepare("UPDATE connections SET state='blocked',revision=revision+1 WHERE ref=?").run(f.binding.connectionRef),
  ()=>db.prepare("UPDATE meta_marketing_business_barriers SET state='aborted' WHERE handover=?").run(h.id),
  ()=>db.prepare('UPDATE meta_marketing_enrollments SET selection_digest=? WHERE id=?').run('0'.repeat(64),h.id),
 ];
 for(let i=0;i<mutations.length;i++){db.exec('SAVEPOINT causal');try{mutations[i]();assert.throws(()=>f.current.store.connection(f.binding.connectionRef,f.now()),{code:'connection_blocked'},'causal '+i);}finally{db.exec('ROLLBACK TO causal;RELEASE causal');}}
 const old=f.binding.metaMarketingOAuth.appVersionId;f.binding.metaMarketingOAuth.appVersionId='z'.repeat(32);assert.throws(()=>f.current.store.connection(f.binding.connectionRef,f.now()),{code:'connection_blocked'});f.binding.metaMarketingOAuth.appVersionId=old;
 assert.equal((await read(f)).data.id,'act_301');
});
test('the current business epoch is tied to its real active maintenance journal, not merely a valid metadata blob',async t=>{
 const {f,h}=await active(t);f.state.clock+=47*86400000;const n=maintenance(f,h.id);await n.rotate();const db=f.current.store.db;
 for(const mutation of [()=>db.prepare('UPDATE meta_marketing_effective_credentials SET epoch=epoch+1 WHERE enrollment=?').run(h.id),()=>db.prepare("UPDATE meta_marketing_credential_maintenance SET state='staged' WHERE id=?").run(n.p.maintenanceId),()=>db.prepare('UPDATE meta_marketing_credential_maintenance SET grant_digest=? WHERE id=?').run('0'.repeat(64),n.p.maintenanceId)]){
  db.exec('SAVEPOINT causal');try{mutation();assert.throws(()=>f.current.store.connection(f.binding.connectionRef,f.now()),{code:'connection_blocked'});}finally{db.exec('ROLLBACK TO causal;RELEASE causal');}
 }
 assert.equal((await read(f)).data.id,'act_301');
});
test('existing per-await connection revision and exact claim guards still stop an in-flight read after the migration deadline',async t=>{
 const {f}=await active(t);f.state.clock+=3*86400000;const db=f.current.store.db;let changed=false;
 f.state.beforeAws=command=>{if(!changed&&command.constructor.name==='GetSecretValueCommand'){changed=true;db.prepare('UPDATE connections SET revision=revision+1 WHERE ref=?').run(f.binding.connectionRef);}};
 await assert.rejects(read(f),{code:'connection_blocked'});assert.equal(changed,true);f.state.beforeAws=null;
 changed=false;f.state.beforeAws=command=>{if(!changed&&command.constructor.name==='GetSecretValueCommand'){changed=true;db.prepare('DELETE FROM meta_marketing_enrollment_claims WHERE asset=?').run('meta-facebook_page:401');}};
 await assert.rejects(read(f),{code:'connection_blocked'});assert.equal(changed,true);
});
test('generic stores keep deadline and block semantics without a resolver; ambiguous or throwing Meta resolvers never grant authority',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{BrokerStore}=require('../src/store');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc-grant-authority-'));fs.chmodSync(dir,0o700);const stores=[];t.after(()=>{for(const s of stores)s.close();fs.rmSync(dir,{recursive:true,force:true});});
 for(const [i,resolver] of [undefined,()=>{throw Error('FICTITIOUS_SECRET_CANARY');},()=>({allowed:true}),()=>true].entries()){
  const s=new BrokerStore(path.join(dir,'s'+i+'.sqlite'));stores.push(s);s.seedConnection('connection:qa',{state:'active',expiresAt:1});
  if(resolver)s.setConnectionAuthorityResolver(resolver);
  if(i===3){assert.equal(s.connection('connection:qa',2).revision,1);s.db.prepare("UPDATE connections SET state='revoked'").run();}
  assert.throws(()=>s.connection('connection:qa',2),{code:'connection_blocked'});
  if(resolver)assert.throws(()=>s.setConnectionAuthorityResolver(()=>true),{code:'invalid_request'});
 }
});

async function ready(t){
 const f=fixture(t,{business:true}),oldFlow=await f.begin(),token=await f.finish(oldFlow),oldId=randomUUID();
 const prepared=await f.execute(E.OPERATIONS.prepare,{enrollmentId:oldId,flowId:oldFlow.flowId,scopeDigest:oldFlow.payload.scopeDigest,candidateDigest:token.data.candidate.digest,assetRefs:['meta-ad_account:301','meta-facebook_page:401']});
 const old=(await f.execute(E.OPERATIONS.activate,{enrollmentId:oldId,scopeDigest:oldFlow.payload.scopeDigest,selectionDigest:prepared.data.selectionDigest})).data;
 const id=randomUUID(),source=f.current.enrollment.renewalAuthority(oldId,f.binding),payload={handoverId:id,flowId:id,newEnrollmentId:id,oldEnrollmentId:oldId,
  expectedEpoch:source.credential.epoch,expectedVersionId:source.credential.versionId,expectedCandidateDigest:source.credential.digest,
  assetSetDigest:R.assetSetDigest(old.assets),oldScopeDigest:old.scopeDigest,scopeDigest:C.hash('FICTITIOUS_BUSINESS_SCOPE_'+id),clinicSetDigest:C.clinicDigest(f.binding.metaMarketingOAuth),state:randomBytes(32).toString('base64url'),expiresAt:f.now()+600000};
 const start=()=>f.execute(B.OPERATIONS.begin,payload),finish=()=>f.execute(B.OPERATIONS.finish,{handoverId:id,flowId:id,state:payload.state,code:'FICTITIOUS_BUSINESS_CODE_'+id});
 const status=()=>f.execute(B.OPERATIONS.status,{handoverId:id},{},true),drain=()=>f.execute(B.OPERATIONS.drain,{handoverId:id},{},true),abort=()=>f.execute(B.OPERATIONS.abort,{handoverId:id},{},true);
 const read=()=>f.execute(M.ASSET,{}, {assetRef:'meta-ad_account:301'},'reader');
 async function activate(candidate,changes={}){const captured=(await drain()).data.drain;return f.execute(B.OPERATIONS.activate,{handoverId:id,newEnrollmentId:id,oldEnrollmentId:oldId,oldGrantDigest:(await status()).data.oldGrantDigest,
  expectedEpoch:payload.expectedEpoch,expectedVersionId:payload.expectedVersionId,expectedCandidateDigest:payload.expectedCandidateDigest,candidateVersionId:id,candidateDigest:candidate.digest,drainDigest:captured.receiptSetDigest},changes);}
 return {f,oldFlow,oldId,old,id,payload,start,finish,status,drain,abort,activate,read};
}
async function transitioned(t){const r=await ready(t);await r.start();const staged=await r.finish();await r.activate(staged.data.candidate);return r;}

test('the same provider lifecycle authority supports BISU without changing USER mode or the business metadata contract',async t=>{
 const r=await transitioned(t),f=r.f;
 // Change the historical migration deadline before capture would change the
 // fingerprint. This fixture instead reaches its pinned 366-day deadline using
 // repeated genuine maintenance receipts with actual advancing provider expiry.
 for(let n=0;n<8;n++){f.state.clock+=47*86400000;const rotate=maintenance(f,r.id);const result=await rotate.rotate();assert.equal(result.data.activationApplied,true);assert.equal(result.data.effectiveCredential.epoch,n+1);}
 assert(f.now()>f.binding.expiresAt);assert.equal((await r.read()).data.id,'act_301');assert.equal(f.state.manages,8);
 f.restart();assert.equal((await r.read()).data.id,'act_301');assert.equal(f.current.enrollment.renewalAuthority(r.id,f.binding).credential.metadata.clientBusinessId,'701');
});
