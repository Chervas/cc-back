'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes,createHmac}=require('node:crypto');
const {fixture,APP}=require('./meta-marketing-oauth-fixture.cjs');
const C=require('../src/meta-marketing-oauth-contract'),B=require('../src/meta-marketing-business-contract'),E=require('../src/meta-marketing-enrollment-contract');
const R=require('../src/meta-marketing-credential-renewal-contract'),T=require('../src/meta-marketing-credential-maintenance-contract'),M=require('../src/meta-marketing-contract');
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
function maintenance(r){const grant=r.f.current.enrollment.renewalAuthority(r.id,r.f.binding),maintenanceId=randomUUID(),payload={maintenanceId,enrollmentId:r.id,expectedEpoch:grant.credential.epoch,expectedVersionId:grant.credential.versionId,expectedCandidateDigest:grant.credential.digest};
 return {maintenanceId,payload,rotate:(overrides={})=>r.f.execute(T.OPERATIONS.rotate,payload,overrides,true),status:()=>r.f.execute(T.OPERATIONS.status,{maintenanceId},{},true)};}

test('business consent uses pinned config/code only and handover changes identity explicitly without losing old history or revoking assets',async t=>{
 const r=await ready(t),before=r.f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(r.oldId);
 const start=await r.start(),url=new URL(start.data.authUrl);assert.equal(url.pathname,'/v27.0/dialog/oauth');assert.equal(url.searchParams.get('config_id'),'777');assert.equal(url.searchParams.get('scope'),null);assert.equal(url.searchParams.get('override_default_response_type'),'true');
 assert.equal((await r.read()).data.id,'act_301');const stage=await r.finish();assert.equal(stage.data.candidate.metadata.tokenType,'SYSTEM_USER');assert.equal(stage.data.candidate.metadata.subjectId,'601');assert.equal(stage.data.candidate.metadata.clientBusinessId,'701');
 assert.equal((await r.read()).data.id,'act_301');const result=await r.activate(stage.data.candidate);assert.equal(result.data.handoverApplied,true);assert.equal(result.data.newEnrollment.enrollmentId,r.id);
 assert.deepEqual(r.f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(r.oldId),before);
 assert.equal(r.f.current.store.db.prepare('SELECT COUNT(*) n FROM asset_revocations').get().n,0);assert.equal((await r.read()).data.id,'act_301');
 assert.equal(r.f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_enrollment_claims WHERE enrollment=?').get(r.id).n,2);
 const puts=r.f.state.puts;await r.f.execute(E.OPERATIONS.revoke,{enrollmentId:r.oldId},{},true);assert.equal(r.f.current.store.db.prepare('SELECT COUNT(*) n FROM asset_revocations').get().n,0);assert.equal(r.f.state.puts,puts);
 assert.equal(r.f.state.codes,2);assert.equal(r.f.state.httpCalls.filter(v=>v.kind==='extend').length,1,'business never performs fb_exchange_token USER extension');
});

test('documented expiring BISU management rotates automatically and subsequent reads use the new epoch across restart',async t=>{
 const r=await transitioned(t);r.f.state.clock+=47*86400000;const n=maintenance(r),result=await n.rotate();assert.equal(result.data.activationApplied,true);assert.equal(result.data.effectiveCredential.epoch,1);assert.equal(result.data.effectiveCredential.versionId,n.maintenanceId);
 assert(result.data.effectiveCredential.metadata.expiresAt>r.f.now()+59*86400000);assert.equal(r.f.state.manages,1);assert.equal((await r.read()).data.id,'act_301');
 r.f.restart();assert.equal((await n.status()).data.activationApplied,true);assert.equal((await r.read()).data.id,'act_301');assert.equal(r.f.state.manages,1);
});

test('cancelled or rejected business consent preserves the old live grant and current credential',async t=>{
 const r=await ready(t);await r.start();r.f.state.afterGraph=(kind,value)=>kind==='business_me'?{...value,client_business_id:'901'}:value;
 await assert.rejects(r.finish(),{code:'oauth_credentials_incomplete'});r.f.state.afterGraph=null;assert.equal((await r.status()).data.status,'rejected');assert.equal((await r.read()).data.id,'act_301');
 await r.abort();assert.equal((await r.read()).data.id,'act_301');assert.equal(r.f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_enrollment_successions').get().n,0);
});

test('drain captures accepted-before-enqueue receipts, allows exact retries and blocks new events; settled duplicates never gain old contact authority',async t=>{
 const r=await ready(t),L=require('../src/meta-marketing-leads-contract');
 const body=lead=>Buffer.from(JSON.stringify({object:'page',entry:[{id:'401',changes:[{field:'leadgen',value:{leadgen_id:lead,form_id:'801',ad_id:'901'}}]}]}));
 const accept=raw=>r.f.execute(L.OPERATIONS.receiptAccept,{adAccountAssetRef:'meta-ad_account:301',rawBase64:raw.toString('base64'),signature:'sha256='+createHmac('sha256',APP).update(raw).digest('hex')},{assetRef:'meta-facebook_page:401'},'reader');
 const raw=body('701'),first=(await accept(raw)).data.receipts[0],before=r.f.current.store.db.prepare('SELECT * FROM meta_marketing_lead_receipts WHERE id=?').get(first.receiptRef);
 await r.start();const staged=await r.finish(),d=(await r.drain()).data.drain;assert.deepEqual(d.receiptRefs,[first.receiptRef]);assert.equal(d.receiptSetDigest,B.drainDigest(r.id,(await r.status()).data.oldGrantDigest,[first.receiptRef]));
 assert.equal((await accept(raw)).data.receipts[0].receiptRef,first.receiptRef);
 await assert.rejects(accept(body('702')),{code:'connection_blocked'});
 const altered=Buffer.from(JSON.stringify(JSON.parse(raw.toString()),null,1));await assert.rejects(accept(altered),{code:'connection_blocked'});
 await r.activate(staged.data.candidate);assert.equal((await accept(raw)).data.receipts[0].receiptRef,first.receiptRef);
 assert.deepEqual(r.f.current.store.db.prepare('SELECT * FROM meta_marketing_lead_receipts WHERE id=?').get(first.receiptRef),before);
 assert.equal(r.f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_lead_receipts').get().n,1);
 await assert.rejects(r.f.execute(L.OPERATIONS.receiptRead,{adAccountAssetRef:'meta-ad_account:301',receiptRef:first.receiptRef},{assetRef:'meta-facebook_page:401'},'reader'),{code:'scope_denied'});
});

test('cancel after closing a drain reopens admission without changing the old grant',async t=>{
 const r=await ready(t);await r.start();await r.finish();await r.drain();assert.equal((await r.status()).data.drain.closed,true);await r.abort();assert.equal((await r.status()).data.drain,null);assert.equal((await r.read()).data.id,'act_301');
});

test('lost provider response recovers through fetch_only without minting or activating twice',async t=>{
 const r=await transitioned(t);r.f.state.clock+=47*86400000;const n=maintenance(r);let lost=false;
 r.f.state.afterGraph=(kind,value)=>{if(kind==='business_manage'&&!lost){lost=true;throw Error('FICTITIOUS_RESPONSE_LOST');}return value;};
 await assert.rejects(n.rotate(),{code:'provider_failed'});r.f.state.afterGraph=null;assert.equal(r.f.state.manages,1);assert.equal((await r.read()).data.id,'act_301');
 const active=(await n.status()).data;assert.equal(active.activationApplied,true);assert.equal(r.f.state.manages,1);assert.equal(r.f.state.fetches,1);assert.equal(active.effectiveCredential.epoch,1);
});

test('lost Secrets Put ACK and failed audit recover existing immutable versions without another management mint',async t=>{
 for(const mode of ['put','audit']){
  const r=await transitioned(t);r.f.state.clock+=47*86400000;const n=maintenance(r),store=r.f.current.store,append=store.appendAudit.bind(store);
  if(mode==='put')r.f.state.losePut=true;
  else store.appendAudit=event=>{if(event.reason==='meta_credential_maintenance_activated')throw Error('FICTITIOUS_AUDIT_ROLLBACK');return append(event);};
  await assert.rejects(n.rotate());store.appendAudit=append;assert.equal(store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_effective_credentials').get().n,0);
  const puts=r.f.state.puts,active=(await n.status()).data;assert.equal(active.activationApplied,true);assert.equal(active.effectiveCredential.epoch,1);assert.equal(r.f.state.manages,1);assert.equal(r.f.state.puts,puts);
 }
});

test('lost applied epoch ACK survives restart and status does not call Meta or mutate Secrets again',async t=>{
 const r=await transitioned(t);r.f.state.clock+=47*86400000;const n=maintenance(r),store=r.f.current.store,complete=store.complete.bind(store);
 store.complete=(...args)=>{complete(...args);throw Error('FICTITIOUS_REPLY_LOST');};await assert.rejects(n.rotate());store.complete=complete;
 const calls=r.f.state.httpCalls.length,puts=r.f.state.puts;r.f.restart();assert.equal((await n.status()).data.activationApplied,true);assert.equal(r.f.state.httpCalls.length,calls);assert.equal(r.f.state.puts,puts);assert.equal(r.f.state.manages,1);
});

test('wrong identity, missing capability and a non-expiring result cannot replace the current business credential',async t=>{
 for(const kind of ['identity','scope','expiry']){
  const r=await transitioned(t);r.f.state.clock+=47*86400000;const n=maintenance(r);
  r.f.state.afterGraph=(type,value)=>type==='business_debug'&&r.f.state.manages?{data:{...value.data,...(kind==='identity'?{user_id:'999'}:kind==='scope'?{scopes:value.data.scopes.filter(s=>s!=='business_management')}:{expires_at:0})}}:value;
  await assert.rejects(n.rotate());r.f.state.afterGraph=null;assert.equal(r.f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_effective_credentials').get().n,0);assert.equal((await r.read()).data.id,'act_301');
 }
});

test('roles, exact epoch and physical withdrawals fail closed before management; expired credentials require human authorization',async t=>{
 const r=await transitioned(t),n=maintenance(r),before=r.f.state.httpCalls.length;
 await assert.rejects(r.f.execute(T.OPERATIONS.rotate,n.payload),{code:'scope_denied'});
 await assert.rejects(r.f.execute(T.OPERATIONS.rotate,{...n.payload,expectedEpoch:3},{},true),{code:'secret_version_changed'});assert.equal(r.f.state.httpCalls.length,before);
 r.f.state.clock+=61*86400000;await assert.rejects(n.rotate(),{code:'credential_revoked'});assert.equal(r.f.state.manages||0,0);
 assert.equal(r.f.current.store.db.prepare('SELECT COUNT(*) n FROM asset_revocations').get().n,0);
});

test('business runtime opt-in pins the separate config, graph version, provider business and exact new grants without changing V1',async t=>{
 const f=fixture(t,{business:true}),main=require('../src/meta-marketing-oauth-main');main.validateConfig(f.config);
 for(const mutate of [c=>c.businessLogin.graphVersion='v99.0',c=>c.businessLogin.providerBusinessId='x',c=>c.businessLogin.configId='0',c=>c.policy.grants[0].operations.push(T.OPERATIONS.rotate),c=>c.businessLogin.scopeKeys=[]]){
  const candidate=structuredClone(f.config);mutate(candidate);assert.throws(()=>main.validateConfig(candidate));
 }
 const old=fixture(t,{enrollment:true});main.validateConfig(old.config);
});

test('a definite provider quota denial requires not-applied status before the SAME rotation command can retry safely',async t=>{
 const r=await transitioned(t);r.f.state.clock+=47*86400000;const n=maintenance(r),requestId=randomUUID();r.f.state.manageRateLimitOnce=true;
 await assert.rejects(n.rotate({requestId}),{code:'rate_limited'});assert.equal(r.f.state.manages,1);assert.equal(r.f.businessTokens.size,1);
 await assert.rejects(n.rotate({requestId}));assert.equal(r.f.state.manages,1,'without status there must be no remint');
 assert.equal((await n.status()).data.status,'not_applied');const result=await n.rotate({requestId});assert.equal(result.data.activationApplied,true);assert.equal(r.f.state.manages,2);assert.equal(r.f.businessTokens.size,2);
});

test('current health performs real fixed Graph inspection outside the renewal window, never rotates, and certifies only the current version',async t=>{
 const r=await transitioned(t),grant=r.f.current.enrollment.renewalAuthority(r.id,r.f.binding),p={enrollmentId:r.id,expectedEpoch:0,expectedVersionId:grant.credential.versionId,expectedCandidateDigest:grant.credential.digest};
 const before=r.f.state.httpCalls.length,healthy=await r.f.execute(T.OPERATIONS.health,p,{},true);assert.equal(healthy.data.healthy,true);assert.equal(healthy.data.reason,null);assert(r.f.state.httpCalls.length>before);assert.equal(r.f.state.manages||0,0);
 r.f.state.afterGraph=(kind,value)=>kind==='business_debug'?{data:{...value.data,is_valid:false}}:value;
 const revoked=await r.f.execute(T.OPERATIONS.health,p,{},true);assert.equal(revoked.data.healthy,false);assert.equal(revoked.data.reason,'credential_revoked');r.f.state.afterGraph=null;
 r.f.state.businessStatus=500;await assert.rejects(r.f.execute(T.OPERATIONS.health,p,{},true),{code:'provider_failed'});r.f.state.businessStatus=200;
 assert.equal((await r.f.execute(T.OPERATIONS.health,p,{},true)).data.healthy,true);assert.equal(r.f.state.manages||0,0);
});

test('health distinguishes explicit current granular denial from a candidate failure and fences stale epoch before any provider call',async t=>{
 const r=await transitioned(t),v=r.f.current.enrollment.renewalAuthority(r.id,r.f.binding).credential,p={enrollmentId:r.id,expectedEpoch:0,expectedVersionId:v.versionId,expectedCandidateDigest:v.digest};
 r.f.state.afterGraph=(kind,value)=>kind==='business_debug'?{data:{...value.data,granular_scopes:[...value.data.granular_scopes,{scope:'pages_manage_metadata',target_ids:[]}]}}:value;
 const denied=await r.f.execute(T.OPERATIONS.health,p,{},true);assert.equal(denied.data.healthy,false);assert.equal(denied.data.reason,'permissions_lost');r.f.state.afterGraph=null;
 const before=r.f.state.httpCalls.length;await assert.rejects(r.f.execute(T.OPERATIONS.health,{...p,expectedEpoch:2},{},true),{code:'secret_version_changed'});assert.equal(r.f.state.httpCalls.length,before);
});

test('large bounded raw granular metadata is fully checked, then projected to the exact selected assets before the 64KiB Secrets write',async t=>{
 const r=await ready(t);await r.start();let bytes=0;
 r.f.state.afterGraph=(kind,value)=>{if(kind!=='business_debug')return value;const ids=['301','401',...Array.from({length:998},(_,i)=>'999999999999999999999999'+String(100000+i))];
  const result={data:{...value.data,granular_scopes:B.SCOPES.map(scope=>({scope,target_ids:scope==='business_management'?['701',...ids.slice(0,999)]:[...ids]}))}};bytes=Buffer.byteLength(JSON.stringify(result));return result;};
 const staged=await r.finish();assert(bytes>131072&&bytes<524288);for(const row of staged.data.candidate.metadata.granularScopes)assert.deepEqual(row.targetIds,row.scope==='business_management'?['301','401','701']:['301','401']);
 const secret=r.f.records.get(r.f.binding.secretArn).get(r.id);assert(Buffer.byteLength(secret.body)<=65536);await r.activate(staged.data.candidate);assert.equal((await r.read()).data.id,'act_301');
});
