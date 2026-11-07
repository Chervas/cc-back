'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto');
const {fixture}=require('./meta-marketing-oauth-fixture.cjs'),C=require('../src/meta-marketing-oauth-contract'),B=require('../src/meta-marketing-business-contract'),A=require('../src/meta-marketing-agency-contract');
const E=require('../src/meta-marketing-enrollment-contract'),R=require('../src/meta-marketing-credential-renewal-contract'),T=require('../src/meta-marketing-credential-maintenance-contract'),M=require('../src/meta-marketing-contract');
async function setup(t,{four=false}={}){const f=fixture(t,{agency:true});if(four){f.state.extraAssets=true;f.businessConfig.bootstrap.assets.push({assetRef:'meta-ad_account:302',tasks:['ANALYZE']},{assetRef:'meta-facebook_page:402',tasks:['ADVERTISE','ANALYZE','MANAGE_LEADS']});f.state.afterGraph=(kind,v)=>{if(kind==='inspect')v.data.granular_scopes[0].target_ids.push('302');if(kind==='adaccounts')v.data.push({...v.data[0],id:'act_302',account_id:'302'});if(kind==='accounts')v.data.push({id:'402',name:'Fictitious second partner page'});return v;};}
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

test('agency fresh admin code creates only a dedicated EMPLOYEE, assigns exact tasks and stages a six-scope expiring SU without pretending BISU',async t=>{
 const {f,oldId}=await setup(t),h=handover(f,oldId),before=f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(oldId),started=await h.start(),url=new URL(started.data.authUrl);
 assert.equal(url.searchParams.get('config_id'),'778');assert.equal(url.searchParams.get('scope'),null);assert.equal(url.pathname,'/v27.0/dialog/oauth');const reply=await h.finish();assert.equal(reply.data.status,'processing');assert.equal((await read(f)).data.id,'act_301');
 const staged=await h.settled();assert.equal(staged.data.status,'staged',f.state.fixtureError?.message);const m=staged.data.candidate.metadata;assert.equal(m.issuerKind,A.ISSUER);assert.equal(m.issuerBusinessId,'901');assert.equal(m.subjectId,'601');assert.equal(m.systemUserId,'601');assert.equal(Object.hasOwn(m,'clientBusinessId'),false);assert.deepEqual(m.scopes,A.SCOPES);
 assert.equal(f.state.agency.creates,1);assert.equal(f.state.agency.mints,1);await h.activate();assert.equal((await read(f)).data.id,'act_301');assert.deepEqual(f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(oldId),before);assert.equal(f.current.store.db.prepare('SELECT COUNT(*) n FROM asset_revocations').get().n,0);
 assert.equal(f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_enrollment_claims WHERE enrollment=?').get(h.id).n,2);
});
test('quota, first-allocation eligibility and app/partner/admin proofs fail before any creation or assignment',async t=>{
 for(const kind of ['quota','eligibility','admin','app','partner']){const {f,oldId}=await setup(t),h=handover(f,oldId);
  if(kind==='quota')f.state.agency.users.push({id:'999',name:'FICTITIOUS_EXISTING_WHATSAPP_USER',role:'EMPLOYEE'});
  if(kind==='eligibility')f.businessConfig.bootstrap.eligibilityExpiresAt=f.now()-1;
  f.state.afterAgency=(input,v)=>kind==='admin'&&input.edge==='business_users'?{data:[{id:'502',role:'EMPLOYEE',business:{id:'901'}}]}:kind==='app'&&input.edge==='owned_apps'?{data:[]}:kind==='partner'&&input.edge==='client_pages'?{data:[]}:v;
  await h.start();await h.finish();assert.notEqual((await h.settled()).data.status,'staged');assert.equal(f.state.agency.creates,0,kind);assert.equal(f.state.agency.mints,0,kind);assert.equal((await read(f)).data.id,'act_301');
 }
});
test('Page Lead Access and form metadata are real pre-stage evidence, not an inferred scope or task',async t=>{
 for(const kind of ['access','pageIdentity','formOwner']){const {f,oldId}=await setup(t),h=handover(f,oldId),puts=f.state.puts;f.state.afterAgency=(input,v)=>kind==='access'&&v.has_lead_access!==undefined?{...v,has_lead_access:{...v.has_lead_access,can_access_lead:false}}:kind==='pageIdentity'&&input.node==='me'&&input.bearer.startsWith('FICTITIOUS_AGENCY_PAGE_TOKEN_')?{id:'999'}:kind==='formOwner'&&input.edge==='leadgen_forms'?{data:[{id:'801',page_id:'999'}]}:v;
  await h.start();await h.finish();assert.equal((await h.settled()).data.status,'rejected',f.state.fixtureError?.message);assert.equal(f.state.puts,puts);assert.equal((await read(f)).data.id,'act_301');assert.equal(f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_enrollment_successions').get().n,0);
 }
});
test('an unknown create ACK is recovered by our durable marker with fresh consent, never by creating a second user or adopting WhatsApp',async t=>{
 const {f,oldId}=await setup(t),h=handover(f,oldId);let lose=true;f.state.afterAgency=(input,v)=>{if(input.edge==='system_users'&&input.method==='POST'&&lose){lose=false;throw Error('FICTITIOUS_CREATE_ACK_LOST');}return v;};
 await h.start();await h.finish();assert.equal((await h.settled()).data.status,'interrupted');assert.equal(f.state.agency.creates,1);assert.equal(f.state.agency.mints,0);await h.abort();
 const next=handover(f,oldId);await next.start();await next.finish();assert.equal((await next.settled()).data.status,'staged',f.state.fixtureError?.message);assert.equal(f.state.agency.creates,1);await next.activate();assert.equal((await read(f)).data.id,'act_301');
});
test('ordinary fresh recovery resumes the same SU after the first deployment proof expires, retaining immutable history',async t=>{
 const {f,h}=await active(t);f.state.clock+=2*86400000;const next=handover(f,h.id);await next.start();await next.finish();assert.equal((await next.settled()).data.status,'staged',f.state.fixtureError?.message);await next.activate();assert.equal(f.state.agency.creates,1);assert.equal(f.state.agency.installs,1);assert.equal(f.state.agency.mints,2);assert.equal((await read(f)).data.id,'act_301');
});
test('agency maintenance uses documented generic GET refresh, validates advanced expiry and preserves history through restart',async t=>{
 const {f,h}=await active(t);f.state.clock+=47*86400000;const n=maintenance(f,h.id),old=f.current.enrollment.renewalAuthority(h.id,f.binding).credential;const result=await n.rotate();assert.equal(result.data.activationApplied,true);assert.equal(result.data.effectiveCredential.epoch,1);assert(result.data.effectiveCredential.metadata.expiresAt>old.metadata.expiresAt);assert.equal(f.state.agency.refreshes,1);assert.equal(f.state.agency.creates,1);f.restart();assert.equal((await n.status()).data.activationApplied,true);assert.equal((await read(f)).data.id,'act_301');assert.equal(f.state.agency.refreshes,1);
});
test('lost generic refresh response remains unknown without a documented fetch-only API or a blind second issue',async t=>{
 const {f,h}=await active(t);f.state.clock+=47*86400000;const n=maintenance(f,h.id);let lose=true;f.state.afterAgency=(input,v)=>{if(input.node==='oauth'&&input.edge==='access_token'&&lose){lose=false;throw Error('FICTITIOUS_REFRESH_ACK_LOST');}return v;};await assert.rejects(n.rotate());assert.equal(f.state.agency.refreshes,1);await assert.rejects(n.status(),{code:'outcome_unknown'});await assert.rejects(n.rotate(),{code:'outcome_unknown'});assert.equal(f.state.agency.refreshes,1);assert.equal((await read(f)).data.id,'act_301');
});
test('issuer contracts reject forged BISU/client identities, broader working scopes and unreviewed tasks',()=>{
 const c=require('./meta-marketing-agency-fixture.cjs').config();assert.throws(()=>A.config({...c,bootstrap:{...c.bootstrap,role:'ADMIN'}}));assert.throws(()=>A.config({...c,bootstrap:{...c.bootstrap,assets:[{assetRef:'meta-ad_account:301',tasks:['MANAGE']}]}}));
 const m={appId:'101',subjectId:'601',tokenType:'SYSTEM_USER',issuerKind:A.ISSUER,issuerBusinessId:'901',systemUserId:'601',configId:'778',graphVersion:'v27.0',scopes:[...A.SCOPES],expiresAt:Date.now()+86400000,dataAccessExpiresAt:null,granularScopes:[]},e={appId:'101',issuerBusinessId:'901',configId:'778',graphVersion:'v27.0'};
 assert.deepEqual(A.validateAgencyMetadata(m,e),m);for(const patch of [{clientBusinessId:'901'},{issuerKind:'BISU'},{systemUserId:'999'},{scopes:[...A.SETUP_SCOPES]}])assert.throws(()=>A.validateAgencyMetadata({...m,...patch},e));
});

test('one agency SU can hand over the full exact four-assets set shared from multiple client portfolios without partial activation',async t=>{
 const {f,oldId}=await setup(t,{four:true}),h=handover(f,oldId);await h.start();await h.finish();const s=await h.settled();assert.equal(s.data.status,'staged',f.state.fixtureError?.message);await h.activate();
 const g=f.current.enrollment.renewalAuthority(h.id,f.binding);assert.deepEqual(g.assets.map(a=>a.assetRef),['meta-ad_account:301','meta-ad_account:302','meta-facebook_page:401','meta-facebook_page:402']);assert.equal(g.credential.metadata.issuerKind,A.ISSUER);assert.equal(f.state.agency.creates,1);assert.equal(f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_enrollment_claims WHERE enrollment=?').get(h.id).n,4);
});
test('provider-faithful HasLeadAccess object is projected safely; a boolean, false permissions or a different page never grants access',()=>{
 const {hasLeadAccess}=require('../src/meta-marketing-page-lead-access'),ok={can_access_lead:true,app_has_leads_permission:true,user_has_leads_permission:true,enabled_lead_access_manager:true,is_page_admin:false,page_id:'401',user_id:'601',failure_reason:'',failure_resolution:''};
 assert.equal(hasLeadAccess(ok,'401'),true);assert.equal(hasLeadAccess({...ok,can_access_lead:false},'401'),false);assert.equal(hasLeadAccess({...ok,app_has_leads_permission:false},'401'),false);assert.equal(hasLeadAccess({...ok,user_has_leads_permission:false},'401'),false);
 for(const v of [true,false,{...ok,can_access_lead:'true'},{...ok,page_id:'999'},{...ok,access_token:'FICTITIOUS_FORBIDDEN'},{...ok,enabled_lead_access_manager:1}])assert.throws(()=>hasLeadAccess(v,'401'));
});
test('cancelling a background bootstrap before provider writes leaves all old authority live and never creates a system user',async t=>{
 const {f,oldId}=await setup(t),h=handover(f,oldId);let entered,release;const pending=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 f.state.afterAgency=async(input,v)=>{if(input.edge==='business_users'){entered();await pending;}return v;};await h.start();assert.equal((await h.finish()).data.status,'processing');await started;await h.abort();release();await new Promise(r=>setImmediate(r));assert.equal((await h.status()).data.status,'aborted');assert.equal(f.state.agency.creates,0);assert.equal((await read(f)).data.id,'act_301');
});
test('current agency health requires real Page lead permission outside the renewal window, while malformed/provider failures remain unknown',async t=>{
 const {f,h}=await active(t),g=f.current.enrollment.renewalAuthority(h.id,f.binding),payload={enrollmentId:h.id,expectedEpoch:g.credential.epoch,expectedVersionId:g.credential.versionId,expectedCandidateDigest:g.credential.digest};
 const health=()=>f.execute(T.OPERATIONS.health,payload,{},true);assert.equal((await health()).data.healthy,true);assert.equal(f.state.agency.refreshes,0);
 f.state.afterAgency=(input,v)=>v.has_lead_access?{...v,has_lead_access:{...v.has_lead_access,can_access_lead:false}}:v;const denied=await health();assert.equal(denied.data.healthy,false);assert.equal(denied.data.reason,'permissions_lost');assert.equal(f.state.agency.refreshes,0);
 f.state.afterAgency=(input,v)=>v.has_lead_access?{...v,has_lead_access:true}:v;await assert.rejects(health(),{code:'provider_failed'});assert.equal(f.state.agency.refreshes,0);
});
test('lost install ACK is confirmed by a newly consented successful mint and full validation, never by fabricating the old ACK or repeating installation',async t=>{
 const {f,oldId}=await setup(t),h=handover(f,oldId);let lose=true;f.state.afterAgency=(input,v)=>{if(input.edge==='applications'&&lose){lose=false;throw Error('FICTITIOUS_INSTALL_ACK_LOST');}return v;};await h.start();await h.finish();assert.equal((await h.settled()).data.status,'interrupted');const before=f.current.store.db.prepare("SELECT * FROM meta_marketing_agency_bootstrap_steps WHERE step='install'").get();assert.equal(before.state,'pending');assert.equal(before.ack_at,null);await h.abort();
 const next=handover(f,oldId);await next.start();await next.finish();assert.equal((await next.settled()).data.status,'staged',f.state.fixtureError?.message);const after=f.current.store.db.prepare("SELECT * FROM meta_marketing_agency_bootstrap_steps WHERE step='install'").get();assert.equal(after.intent_at,before.intent_at);assert.equal(after.ack_at,null);assert.equal(after.confirmation,'confirmed_by_validated_token');assert.equal(after.state,'confirmed');assert.equal(f.state.agency.installs,1);assert.equal(f.state.agency.creates,1);await next.activate();
});
test('unknown installation that really did not apply remains closed after fresh consent, without a blind install replay or change to the old grant',async t=>{
 const {f,oldId}=await setup(t),h=handover(f,oldId);let lose=true;f.state.afterAgency=(input,v)=>{if(input.edge==='applications'&&lose){lose=false;f.state.agency.installed=false;throw Error('FICTITIOUS_INSTALL_DID_NOT_APPLY');}return v;};await h.start();await h.finish();assert.equal((await h.settled()).data.status,'interrupted');await h.abort();const next=handover(f,oldId);await next.start();await next.finish();assert.equal((await next.settled()).data.status,'interrupted');assert.equal(f.state.agency.installs,1);assert.equal(f.state.agency.creates,1);assert.equal(f.current.store.db.prepare("SELECT ack_at FROM meta_marketing_agency_bootstrap_steps WHERE step='install'").get().ack_at,null);assert.equal((await read(f)).data.id,'act_301');
});
