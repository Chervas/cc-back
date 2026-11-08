'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {fixture}=require('./meta-marketing-oauth-fixture.cjs');
const C=require('../src/meta-marketing-oauth-contract'),M=require('../src/meta-marketing-contract'),B=require('../src/meta-marketing-business-contract'),A=require('../src/meta-marketing-agency-contract');
const I=require('../src/meta-marketing-business-issuer'),K=require('../src/meta-marketing-credential-shape'),E=require('../src/meta-marketing-enrollment-contract'),R=require('../src/meta-marketing-credential-renewal-contract'),T=require('../src/meta-marketing-credential-maintenance-contract');
const L=require('../src/meta-marketing-leads-contract');
function legacyConfig(agency=false){return agency?require('./meta-marketing-agency-fixture.cjs').config():{enabled:true,cohort:B.COHORT,configId:'777',graphVersion:'v27.0',providerBusinessId:'901',scopeKeys:['group:9']};}
function paidConfig(old,agency=false){return {...structuredClone(old),cohort:agency?A.PAID_COHORT:B.PAID_COHORT,configId:agency?'1778':'1777'};}
async function ready(t,options={}){
 const f=fixture(t,{business:true,...options}),flow=await f.begin(),token=(await f.finish(flow)).data.candidate,id=randomUUID();
 const p=(await f.execute(E.OPERATIONS.prepare,{enrollmentId:id,flowId:flow.flowId,scopeDigest:flow.payload.scopeDigest,candidateDigest:token.digest,assetRefs:['meta-ad_account:301','meta-facebook_page:401']})).data;
 await f.execute(E.OPERATIONS.activate,{enrollmentId:id,scopeDigest:flow.payload.scopeDigest,selectionDigest:p.selectionDigest});return {f,oldId:id};
}
function handover(f,oldId){const id=randomUUID(),source=f.current.enrollment.renewalAuthority(oldId,f.binding),p={handoverId:id,flowId:id,newEnrollmentId:id,oldEnrollmentId:oldId,expectedEpoch:source.credential.epoch,expectedVersionId:source.credential.versionId,expectedCandidateDigest:source.credential.digest,
 assetSetDigest:R.assetSetDigest(source.assets),oldScopeDigest:source.row.scope_digest,scopeDigest:C.hash('FICTITIOUS_PAID_PROFILE_'+id),clinicSetDigest:C.clinicDigest(f.binding.metaMarketingOAuth),state:randomBytes(32).toString('base64url'),expiresAt:f.now()+600000};
 const status=()=>f.execute(B.OPERATIONS.status,{handoverId:id},{},true);
 async function settled(){for(let n=0;n<100;n++){const s=await status();if(s.data.status!=='processing')return s;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('OFFLINE_HANDOVER_NOT_SETTLED');}
 return {id,p,status,settled,start:()=>f.execute(B.OPERATIONS.begin,p),finish:()=>f.execute(B.OPERATIONS.finish,{handoverId:id,flowId:id,state:p.state,code:(f.state.agency?'FICTITIOUS_AGENCY_CODE_':'FICTITIOUS_BUSINESS_CODE_')+id}),abort:()=>f.execute(B.OPERATIONS.abort,{handoverId:id},{},true),
 async activate(){const s=await settled(),d=await f.execute(B.OPERATIONS.drain,{handoverId:id},{},true);return f.execute(B.OPERATIONS.activate,{handoverId:id,newEnrollmentId:id,oldEnrollmentId:oldId,oldGrantDigest:s.data.oldGrantDigest,expectedEpoch:p.expectedEpoch,expectedVersionId:p.expectedVersionId,expectedCandidateDigest:p.expectedCandidateDigest,candidateVersionId:id,candidateDigest:s.data.candidate.digest,drainDigest:d.data.drain.receiptSetDigest});}};
}
async function active(t,options={}){const r=await ready(t,options),h=handover(r.f,r.oldId);await h.start();await h.finish();assert.equal((await h.settled()).data.status,'staged',r.f.state.fixtureError?.stack);await h.activate();return {...r,h};}
const read=f=>f.execute(M.ASSET,{},{assetRef:'meta-ad_account:301'},'reader');
async function rotate(f,id){const g=f.current.enrollment.renewalAuthority(id,f.binding),maintenanceId=randomUUID();return f.execute(T.OPERATIONS.rotate,{maintenanceId,enrollmentId:id,expectedEpoch:g.credential.epoch,expectedVersionId:g.credential.versionId,expectedCandidateDigest:g.credential.digest},{},true);}

test('the original published v1 fingerprint vectors and generic USER/Business scope lists remain byte-identical',t=>{
 const f=fixture(t,{business:true});f.binding.expiresAt=1893456000000;const ac=legacyConfig(true);ac.bootstrap.eligibilityExpiresAt=1893456000000;
 // Produced from the unmodified a8e94859 contract sources, with these fixed inputs.
 assert.equal(B.fingerprint(B.derive(f.binding,f.businessConfig)),'aa023ceb15e54c305193c32a563ff3e112e4474a36aebb91fb73efa5c3ee0d72');
 assert.equal(A.fingerprint(A.derive(f.binding,ac)),'148d96943f5dab52ef29f468d6de831c7ce3cacc032853eca20605b7535ff7e4');
 assert.deepEqual(B.SCOPES,['ads_read','business_management','leads_retrieval','pages_manage_ads','pages_manage_metadata','pages_read_engagement','pages_show_list']);
 assert.deepEqual(A.SCOPES,['ads_read','leads_retrieval','pages_manage_ads','pages_manage_metadata','pages_read_engagement','pages_show_list']);
 assert.equal(M.SCOPES.includes('ads_management'),false);assert.equal(C.SCOPES.includes('ads_management'),true);
 assert.deepEqual(A.PAID_SETUP_SCOPES,B.PAID_SCOPES);assert.equal(A.PAID_SCOPES.includes('business_management'),false);
});

for(const agency of [false,true])test(`${agency?'Agency':'BISU'} paid V2 stages its exact profile, refreshes and preserves the original grant through restart`,async t=>{
 const {f,h,oldId}=await active(t,{agency,businessPermissionProfile:'paid-leads-v2'}),expected=agency?A.PAID_SCOPES:B.PAID_SCOPES;
 const grant=f.current.enrollment.renewalAuthority(h.id,f.binding);assert.deepEqual(grant.credential.metadata.scopes,expected);assert(!grant.credential.metadata.scopes.includes('public_profile'));
 const old=f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(oldId),original=f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(h.id);
 assert.equal((await read(f)).data.id,'act_301');f.state.clock+=47*86400000;
 const result=await rotate(f,h.id);assert.equal(result.data.activationApplied,true);assert.equal(result.data.effectiveCredential.epoch,1);assert.deepEqual(result.data.effectiveCredential.metadata.scopes,expected);
 f.restart();assert.equal((await read(f)).data.id,'act_301');assert.deepEqual(f.current.enrollment.renewalAuthority(h.id,f.binding).credential.metadata.scopes,expected);
 assert.deepEqual(f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(oldId),old);assert.deepEqual(f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(h.id),original);
 assert.equal(f.current.store.db.prepare('SELECT COUNT(*) n FROM asset_revocations').get().n,0);
 if(agency){assert.equal(f.state.agency.creates,1);assert.equal(f.state.agency.mints,1);assert.equal(f.state.agency.refreshes,1);assert.deepEqual(f.businessConfig.bootstrap.assets.find(a=>a.assetRef==='meta-ad_account:301').tasks,['ANALYZE']);}else assert.equal(f.state.manages,1);
});

for(const agency of [false,true])test(`${agency?'Agency':'BISU'} historical v1 remains effective after a different V2 target is registered, including automatic refresh`,async t=>{
 const old=legacyConfig(agency),registry={active:[old],history:[]},{f,h}=await active(t,{agency,businessRegistry:registry});
 const before=f.current.enrollment.renewalAuthority(h.id,f.binding),beforeRow=f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(h.id),fingerprint=K.fingerprint(before.binding);
 registry.active[0]=paidConfig(old,agency);registry.history.push({appId:'101',configuration:old});f.restart();
 const after=f.current.enrollment.renewalAuthority(h.id,f.binding);assert.equal(K.fingerprint(after.binding),fingerprint);assert.equal(after.credential.digest,before.credential.digest);assert.equal(after.credential.epoch,0);assert.deepEqual(after.credential.metadata.scopes,agency?A.SCOPES:B.SCOPES);
 assert.equal((await read(f)).data.id,'act_301');f.state.clock+=47*86400000;const updated=await rotate(f,h.id);assert.deepEqual(updated.data.effectiveCredential.metadata.scopes,agency?A.SCOPES:B.SCOPES);assert.equal(updated.data.effectiveCredential.epoch,1);
 assert.deepEqual(f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(h.id),beforeRow);
 const next=handover(f,h.id),url=new URL((await next.start()).data.authUrl);assert.equal(url.searchParams.get('config_id'),registry.active[0].configId);await next.abort();assert.equal((await read(f)).data.id,'act_301');
 registry.history.length=0;f.restart();await assert.rejects(read(f),{code:'scope_denied'});
});

test('an old pending flow keeps its captured configuration and can cancel after target V2 is selected without another code exchange',async t=>{
 const old=legacyConfig(),registry={active:[old],history:[]},{f,oldId}=await ready(t,{businessRegistry:registry}),h=handover(f,oldId);await h.start();const flowBefore=f.current.store.db.prepare('SELECT * FROM meta_marketing_oauth_flows WHERE id=?').get(h.id),codes=f.state.codes;
 registry.active[0]=paidConfig(old);registry.history.push({appId:'101',configuration:old});f.restart();assert.equal((await h.status()).data.status,'awaiting');await h.abort();assert.equal((await h.status()).data.status,'aborted');assert.equal(f.state.codes,codes);assert.equal((await read(f)).data.id,'act_301');
 const after=f.current.store.db.prepare('SELECT * FROM meta_marketing_oauth_flows WHERE id=?').get(h.id);assert.equal(after.binding_digest,flowBefore.binding_digest);assert.equal(after.secret_digest,flowBefore.secret_digest);
 const next=handover(f,oldId);assert.equal(new URL((await next.start()).data.authUrl).searchParams.get('config_id'),'1777');await next.abort();
});

test('historical registration cannot start OAuth, cross apps or issuers, duplicate a config ID, or authorize metadata through extra scopes',async t=>{
 const f=fixture(t,{business:true}),old=legacyConfig(),paid=paidConfig(old),b=B.derive(f.binding,old),raw={data:{is_valid:true,app_id:'101',user_id:'601',type:'SYSTEM_USER',scopes:[...B.SCOPES,'ads_management','whatsapp_business_messaging'],expires_at:Math.floor(f.now()/1000)+86400,data_access_expires_at:0,granular_scopes:[]}},m=B.inspected(raw,b,f.now(),{id:'601',client_business_id:'701'});
 assert.deepEqual(m.scopes,B.SCOPES);const history={active:[],history:[{appId:'101',configuration:old}]};assert.equal(I.fingerprint(I.forCredential(f.binding,history,m)),B.fingerprint(b));assert.throws(()=>I.selected(f.binding,history),{code:'scope_denied'});
 assert.throws(()=>I.config({active:[old],history:[{appId:'101',configuration:old}]}),{code:'invalid_request'});
 assert.throws(()=>I.forCredential(f.binding,{active:[paid],history:[{appId:'102',configuration:old}]},m),{code:'scope_denied'});
 assert.throws(()=>I.forCredential(f.binding,history,{...m,issuerKind:A.ISSUER}),{code:'scope_denied'});
 const pb=B.derive(f.binding,paid);assert.throws(()=>B.metadata(m,pb),{code:'oauth_credentials_incomplete'});assert.throws(()=>B.inspected(raw,pb,f.now(),{id:'601',client_business_id:'901'}),{code:'oauth_credentials_incomplete'});
 for(const change of [v=>v.data.scopes=v.data.scopes.filter(s=>s!=='ads_management'),v=>v.data.type='USER',v=>v.data.app_id='102']){const value=structuredClone(raw);change(value);assert.throws(()=>B.inspected(value,pb,f.now(),{id:'601',client_business_id:'701'}));}
 const projected=B.inspected(raw,pb,f.now(),{id:'601',client_business_id:'701'});assert.deepEqual(projected.scopes,B.PAID_SCOPES);assert.equal(projected.scopes.includes('whatsapp_business_messaging'),false);
 assert.throws(()=>M.inspectBusinessCredential(raw,{appId:'101',subjectId:'601',scopes:B.PAID_SCOPES},f.now()),{code:'invalid_request'});
 const ab=A.derive(f.binding,paidConfig(legacyConfig(true),true)),ar={data:{...raw.data,scopes:[...A.PAID_SCOPES,'business_management','whatsapp_business_messaging']}};
 const av=A.inspected(ar,ab,f.now(),{id:'601',systemUserId:'601'});assert.deepEqual(av.scopes,A.PAID_SCOPES);assert.equal(av.scopes.includes('business_management'),false);
 assert.throws(()=>A.inspected({data:{...ar.data,type:'USER'}},ab,f.now(),{id:'601',systemUserId:'601'}));
 assert.throws(()=>A.inspected({data:{...ar.data,scopes:A.SCOPES}},ab,f.now(),{id:'601',systemUserId:'601'}));
});

test('runtime registers bounded app-pinned history separately from the target without expanding ordinary USER or campaign operations',t=>{
 const f=fixture(t,{business:true}),main=require('../src/meta-marketing-oauth-main'),candidate=structuredClone(f.config),old=legacyConfig();candidate.businessLogin=paidConfig(old);candidate.businessCredentialHistory=[{appId:'101',configuration:old}];assert.equal(main.validateConfig(candidate),candidate);
 for(const mutate of [v=>v.businessCredentialHistory[0].appId='102',v=>v.businessCredentialHistory[0].configuration.configId=v.businessLogin.configId,v=>v.businessCredentialHistory[0].configuration.cohort='unregistered',v=>v.businessCredentialHistory[0].configuration.scopeKeys=['group:10'],v=>v.businessCredentialHistory[0].configuration.unrestricted=true]){const bad=structuredClone(candidate);mutate(bad);assert.throws(()=>main.validateConfig(bad),{code:'invalid_request'});}
 const many={active:[candidate.businessLogin],history:Array.from({length:4},(_,i)=>({appId:'101',configuration:{...old,configId:String(2000+i)}}))};assert.throws(()=>I.config(many),{code:'invalid_request'});
 assert.deepEqual(f.config.policy.grants,candidate.policy.grants);assert.equal(Object.values(B.OPERATIONS).some(v=>/campaign/.test(v)),false);assert.equal(candidate.enrolledAssetAccess,undefined);
});

for(const agency of [false,true])test(`${agency?'Agency':'BISU'} missing V2 permission rejects staging and leaves the USER grant and both clinics intact`,async t=>{
 const {f,oldId}=await ready(t,{agency,businessPermissionProfile:'paid-leads-v2'}),h=handover(f,oldId),old=f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(oldId),puts=f.state.puts;
 if(agency)f.state.afterAgency=(input,value)=>input.node==='debug_token'&&value.data?.type==='USER'?{data:{...value.data,scopes:value.data.scopes.filter(s=>s!=='ads_management')}}:value;
 else f.state.afterGraph=(kind,value)=>kind==='business_debug'?{data:{...value.data,scopes:value.data.scopes.filter(s=>s!=='ads_management')}}:value;
 await h.start();if(agency){await h.finish();assert.equal((await h.settled()).data.status,'rejected');assert.equal(f.state.agency.creates,0);}else await assert.rejects(h.finish(),{code:'oauth_credentials_incomplete'});
 assert.equal(f.state.puts,puts);assert.deepEqual(f.current.store.db.prepare('SELECT * FROM meta_marketing_enrollments WHERE id=?').get(oldId),old);assert.equal((await read(f)).data.id,'act_301');assert.equal(f.current.store.db.prepare('SELECT clinic_digest FROM meta_marketing_oauth_flows WHERE id=?').get(old.flow).clinic_digest,C.clinicDigest(f.binding.metaMarketingOAuth));assert.deepEqual(f.binding.metaMarketingOAuth.clinicIds,[71,72]);
});

for(const agency of [false,true])test(`${agency?'Agency':'BISU'} lost paid granular access on the refreshed candidate cannot replace the current epoch`,async t=>{
 const {f,h}=await active(t,{agency,businessPermissionProfile:'paid-leads-v2'}),before=f.current.enrollment.renewalAuthority(h.id,f.binding).credential,puts=f.state.puts;f.state.clock+=47*86400000;
 const deny=value=>value.data?.type==='SYSTEM_USER'&&value.data.expires_at*1000>f.now()+59*86400000?{data:{...value.data,granular_scopes:[{scope:'ads_management',target_ids:[]}]}}:value;
 if(agency)f.state.afterAgency=(input,value)=>input.node==='debug_token'?deny(value):value;else f.state.afterGraph=(kind,value)=>kind==='business_debug'?deny(value):value;
 await assert.rejects(rotate(f,h.id),{code:'scope_denied'});const after=f.current.enrollment.renewalAuthority(h.id,f.binding).credential;
 assert.equal(after.epoch,before.epoch);assert.equal(after.versionId,before.versionId);assert.equal(after.digest,before.digest);assert.equal(f.state.puts,puts);assert.equal((await read(f)).data.id,'act_301');
});

function leadTransport(f){const calls=[];let accountId='301';const PAGE_TOKEN='FICTITIOUS_PAID_PAGE_TOKEN';
 const request=(settings,callback)=>{const u=new URL('https://graph.facebook.com'+settings.path);if(u.pathname.endsWith('/debug_token')&&u.searchParams.get('input_token')!==PAGE_TOKEN)return f.request(settings,callback);
 const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{try{assert.equal(settings.method,'GET');assert.equal(settings.hostname,'graph.facebook.com');assert.equal(settings.rejectUnauthorized,true);const fields=u.searchParams.get('fields');calls.push({node:u.pathname,fields,method:settings.method});let value;
 if(u.pathname.endsWith('/debug_token'))value={data:{is_valid:true,type:'PAGE',app_id:'101',profile_id:'401',scopes:['leads_retrieval'],expires_at:0,data_access_expires_at:0}};
 else if(u.pathname==='/v27.0/401')value={id:'401',access_token:PAGE_TOKEN};
 else if(u.pathname==='/v27.0/me')value={id:'401'};
 else if(u.pathname==='/v27.0/702')value={id:'702',page_id:'401',name:'FICTITIOUS_FORM',status:'ACTIVE',questions:[{key:'name',type:'FULL_NAME'},{key:'mail',type:'EMAIL'},{key:'secret_health',type:'CUSTOM'}]};
 else if(u.pathname==='/v27.0/603')value={id:'603',account_id:accountId,campaign_id:'601',adset_id:'602'};
 else if(u.pathname==='/v27.0/701')value={id:'701',form_id:'702',ad_id:'603',campaign_id:'601',created_time:'2026-11-08T12:00:00+0000',is_organic:false,...(fields.includes('field_data')?{field_data:[{name:'name',values:['FICTITIOUS_PERSON']},{name:'mail',values:['qa@example.invalid']},{name:'secret_health',values:['NEVER_RETURN']}]}:{})};
 else assert.fail('Unexpected fixed paid Graph path '+u.pathname);const response=new PassThrough();response.statusCode=200;response.headers={'content-type':'application/json'};callback(response);response.end(JSON.stringify(value));}catch(error){req.emit('error',error);}});return req;};
 const pacer=require('../src/meta-marketing-ads-pacing').createPacing({state:require('../src/meta-marketing-ads-pacing').sqliteState(f.current.store.db),now:f.now,wait:async ms=>{f.state.clock+=ms;}}),http=require('../src/meta-marketing-leads-http').createMetaMarketingLeadsHttp({request,pacer,cursor:require('../src/provider-cursor').cursorCodec(randomBytes(32),f.now),now:f.now});
 return {calls,http,wrongAccount:()=>{accountId='999';}};
}
for(const agency of [false,true])test(`${agency?'Agency':'BISU'} V2 fixed paid reader verifies account attribution before contacts and rejects granular account denial before HTTP`,async t=>{
 const {f,h}=await active(t,{agency,businessPermissionProfile:'paid-leads-v2'}),g=f.current.enrollment.renewalAuthority(h.id,f.binding),transport=leadTransport(f),page=g.assets.find(a=>a.kind==='facebook_page'),account=g.assets.find(a=>a.kind==='ad_account');
 const invoke=metadata=>f.secrets.withCandidate(g.binding,g.credential.flow,g.credential.digest,borrowed=>transport.http.read({binding:g.binding,metadata:metadata||borrowed.metadata,token:borrowed.token,appSecret:borrowed.appSecret,asset:page,account,operation:L.OPERATIONS.receiptRead,payload:{adAccountAssetRef:account.assetRef,receiptRef:randomUUID()},signal:new AbortController().signal,authorize:()=>{},context:{principalId:'staging:meta-marketing',tenantRef:'clinic:71',policyVersion:'FICTITIOUS_V2'},receipt:{lead_id:'701',page_id:'401',form_id:'702',ad_id:'603'},recipientClinicId:71}),new AbortController().signal,{retentionStage:g.credential.retentionStage});
 const result=await invoke();assert.deepEqual(result.identity,{account_id:'301',campaign_id:'601',ad_id:'603',adset_id:'602'});assert.deepEqual(result.lead.field_data.map(v=>v.name),['full_name','email']);assert(transport.calls.every(v=>v.method==='GET'));
 const ad=transport.calls.findIndex(v=>v.node==='/v27.0/603'),contact=transport.calls.findIndex(v=>v.fields?.includes('field_data'));assert(ad>=0&&contact>ad);
 transport.calls.length=0;transport.wrongAccount();await assert.rejects(invoke(),{code:'scope_denied'});assert.equal(transport.calls.some(v=>v.fields?.includes('field_data')),false);
 transport.calls.length=0;await assert.rejects(invoke({...g.credential.metadata,granularScopes:[{scope:'ads_management',targetIds:[]}]}),{code:'scope_denied'});assert.equal(transport.calls.length,0);
});
