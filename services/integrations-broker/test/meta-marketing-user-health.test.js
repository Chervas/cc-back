'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('./meta-marketing-oauth-fixture.cjs'),{Broker}=require('../src/broker');
const E=require('../src/meta-marketing-enrollment-contract'),T=require('../src/meta-marketing-credential-maintenance-contract');
const fs=require('node:fs'),CANARY='DO_NOT_LOG_CONTACT_TOKEN_OR_PROVIDER_MESSAGE_qa@example.invalid';
async function capture(work,{brokenSink=false}={}){
 const original=fs.writeSync,lines=[];let result,error;
 fs.writeSync=function(fd,chunk,...args){if(fd!==2)return original.call(this,fd,chunk,...args);
  if(brokenSink)throw Error(CANARY);lines.push(String(chunk));return Buffer.byteLength(String(chunk));};
 try{result=await work();}catch(value){error=value;}finally{fs.writeSync=original;}
 return{result,error,lines,events:lines.map(value=>JSON.parse(value))};
}
function diagnostic(observed){
 assert.equal(observed.lines.length,1);assert(Buffer.byteLength(observed.lines[0])<=512);
 for(const secret of [CANARY,'FICTITIOUS_META_OAUTH_TOKEN','0123456789abcdef'.repeat(2)])assert(!observed.lines[0].includes(secret));
 const value=observed.events[0];assert.deepEqual(Object.keys(value).sort(),
  ['event','version','scopeKey','credentialContext','isValid','metaCode','metaSubcode','error'].sort());
 assert.equal(value.event,'meta_marketing_user_health_failed');assert.equal(value.version,1);
 assert.equal(value.scopeKey,'group:9');assert.equal(value.credentialContext,'primary');return value;
}
async function ready(t){
 const f=fixture(t,{discovery:true,enrollment:true,renewal:true}),flow=await f.begin(),token=await f.finish(flow),id=randomUUID();
 const p=await f.execute(E.OPERATIONS.prepare,{enrollmentId:id,flowId:flow.flowId,scopeDigest:flow.payload.scopeDigest,candidateDigest:token.data.candidate.digest,assetRefs:['meta-ad_account:301','meta-facebook_page:401']});
 await f.execute(E.OPERATIONS.activate,{enrollmentId:id,scopeDigest:flow.payload.scopeDigest,selectionDigest:p.data.selectionDigest});
 const control=f.policy.grants.find(g=>g.principalId.startsWith('control:'));control.operations.push(T.OPERATIONS.health);
 const owner=require('../src/meta-marketing-credential-maintenance').createMetaMarketingCredentialMaintenance({store:f.current.store,epochs:f.current.epochs,enrollment:f.current.enrollment,secrets:f.secrets,http:f.http,
  userHealthHttp:require('../src/meta-marketing-user-health-http').createUserHealthHttp({request:f.request,now:f.now}),environment:'staging',now:f.now});t.after(()=>owner.close());
 const instance={broker:new Broker({store:f.current.store,policy:f.policy,secrets:f.secrets,policyResolver:f.current.enrollment,operations:owner.operations,now:f.now})};
 const c=f.current.enrollment.renewalAuthority(id,f.binding).credential,payload={enrollmentId:id,expectedEpoch:c.epoch,expectedVersionId:c.versionId,expectedCandidateDigest:c.digest};
 const health=(changes={},control=true)=>f.execute(T.OPERATIONS.health,{...payload,...changes},{},control,instance);
 return{f,id,c,payload,health,owner,instance};
}
test('USER health verifies the actual provider credential and selected assets without minting or changing epoch',async t=>{
 const r=await ready(t),before=r.f.state.codes,puts=r.f.state.puts,result=await r.health();
 assert.equal(result.data.healthy,true);assert.equal(result.data.reason,null);assert.equal(result.data.epoch,r.c.epoch);assert.equal(result.data.versionId,r.c.versionId);
 assert.equal(result.data.expiresAt,r.c.metadata.expiresAt);assert.equal(r.f.state.codes,before);assert.equal(r.f.state.puts,puts);
 assert.equal(r.f.current.store.db.prepare('SELECT COUNT(*) n FROM meta_marketing_credential_maintenance').get().n,0);
 assert(r.f.current.store.db.prepare("SELECT COUNT(*) n FROM audit_outbox WHERE event LIKE '%meta_credential_maintenance_health_verified%'").get().n>0);
});
test('a valid shorter observed USER expiry is reported conservatively without inventing revocation',async t=>{
 const r=await ready(t);r.f.state.afterGraph=(kind,value)=>kind==='inspect'?{...value,data:{...value.data,expires_at:Math.floor(r.f.now()/1000)+1800}}:value;
 const result=await r.health();assert.equal(result.data.healthy,true);assert.equal(result.data.expiresAt,Math.floor(r.f.now()/1000)*1000+1800000);assert.equal(result.data.reason,null);
});
test('an application debug rejection stays unknown and cannot invalidate the USER',async t=>{
 const r=await ready(t);r.f.state.afterGraph=(kind,value)=>kind==='inspect'?{error:{code:190,error_subcode:460}}:value;
 await assert.rejects(r.health(),{code:'secret_unavailable'});
 assert.equal(r.f.current.enrollment.renewalAuthority(r.id,r.f.binding).credential.epoch,r.c.epoch);
});
test('the provider invalid flag and missing required scope are distinct health denials',async t=>{
 const r=await ready(t);r.f.state.afterGraph=(kind,value)=>kind==='inspect'?{...value,data:{...value.data,is_valid:false}}:value;
 const invalid=await r.health();assert.equal(invalid.data.healthy,false);assert.equal(invalid.data.reason,'credential_revoked');
 r.f.state.afterGraph=(kind,value)=>kind==='inspect'?{...value,data:{...value.data,scopes:[]}}:value;
 // Empty malformed scopes are not evidence of a specific permission withdrawal.
 await assert.rejects(r.health(),{code:'oauth_credentials_incomplete'});
 r.f.state.afterGraph=(kind,value)=>kind==='inspect'?{...value,data:{...value.data,scopes:value.data.scopes.filter(s=>s!=='ads_read')}}:value;
 const permissions=await r.health();assert.equal(permissions.data.healthy,false);assert.equal(permissions.data.reason,'permissions_lost');
});
test('wrong pins, wrong caller and retired enrollment remain closed before provider access',async t=>{
 const r=await ready(t),count=r.f.state.httpCalls.length;
 await assert.rejects(r.health({expectedEpoch:r.c.epoch+1}));await assert.rejects(r.health({},false));assert.equal(r.f.state.httpCalls.length,count);
 await r.f.execute(E.OPERATIONS.revoke,{enrollmentId:r.id},{},true);await assert.rejects(r.health());assert.equal(r.f.state.httpCalls.length,count);
});
test('USER health grants are explicit and never include rotation',async t=>{
 const r=await ready(t),config={...r.f.config,userCredentialHealth:{scopeKeys:[r.f.binding.metaMarketingOAuth.scopeKey]}};
 const validate=require('../src/meta-marketing-oauth-main').validateConfig;assert.equal(validate(config),config);
 const changed=structuredClone(config);changed.policy.grants.find(g=>g.principalId.startsWith('control:')).operations.push(T.OPERATIONS.rotate);assert.throws(()=>validate(changed));
 await assert.rejects(r.f.execute(T.OPERATIONS.rotate,{maintenanceId:randomUUID(),...r.payload},{},true,r.instance));
 assert.equal(r.f.state.manages||0,0);
});


test('an expired observed USER deadline is reported as expiry without minting or enabling data reads',async t=>{
 const r=await ready(t),codes=r.f.state.codes;
 r.f.state.afterGraph=(kind,value)=>kind==='inspect'?{...value,data:{...value.data,expires_at:Math.floor(r.f.now()/1000)-1}}:value;
 const result=await r.health();assert.equal(result.data.healthy,false);assert.equal(result.data.reason,'credential_expired');
 assert(result.data.expiresAt<r.f.now());assert.equal(r.f.state.codes,codes);
});

test('invalid USER health retains only bounded nested Meta code/subcode and never provider secrets',async t=>{
 const r=await ready(t),puts=r.f.state.puts;
 r.f.state.afterGraph=(kind,value)=>kind==='inspect'?{...value,data:{...value.data,is_valid:false,
  error:{code:190,error_subcode:463,message:CANARY,error_user_title:'FICTITIOUS_META_OAUTH_TOKEN',unknown:'0123456789abcdef'.repeat(2)}}}:value;
 const observed=await capture(()=>r.health()),entry=diagnostic(observed);assert.ifError(observed.error);
 assert.equal(entry.isValid,false);assert.equal(entry.metaCode,190);assert.equal(entry.metaSubcode,463);assert.equal(entry.error,'credential_revoked');
 assert.equal(observed.result.data.healthy,false);assert.equal(observed.result.data.reason,'credential_revoked');
 assert.equal(r.f.state.puts,puts);assert.equal(r.f.current.enrollment.renewalAuthority(r.id,r.f.binding).credential.epoch,r.c.epoch);
});
test('health diagnostics accept the nested subcode spelling and discard malformed numeric fields',async t=>{
 const r=await ready(t);
 for(const [error,code,subcode] of [[{code:190,subcode:460},190,460],
  [{code:'190',error_subcode:2147483648,subcode:CANARY},null,null]]){
  r.f.state.afterGraph=(kind,value)=>kind==='inspect'?{...value,data:{...value.data,is_valid:false,error}}:value;
  const observed=await capture(()=>r.health()),entry=diagnostic(observed);assert.ifError(observed.error);
  assert.equal(entry.metaCode,code);assert.equal(entry.metaSubcode,subcode);assert.equal(entry.isValid,false);
 }
});
test('app inspector and transport failures do not invent raw USER validity or provider codes',async t=>{
 const r=await ready(t);
 r.f.state.afterGraph=(kind,value)=>kind==='inspect'?{error:{code:190,error_subcode:460,message:CANARY}}:value;
 const app=await capture(()=>r.health()),entry=diagnostic(app);assert.equal(app.error.code,'secret_unavailable');
 assert.equal(entry.error,'secret_unavailable');assert.equal(entry.isValid,null);assert.equal(entry.metaCode,null);assert.equal(entry.metaSubcode,null);
 r.f.state.afterGraph=kind=>{if(kind==='inspect')throw Error(CANARY);};
 const transport=await capture(()=>r.health()),failed=diagnostic(transport);assert.equal(transport.error.code,'provider_failed');
 assert.equal(failed.isValid,null);assert.equal(failed.metaCode,null);assert.equal(failed.metaSubcode,null);
});
test('successful health emits no failure event and a broken diagnostic sink preserves denial',async t=>{
 const r=await ready(t),success=await capture(()=>r.health());assert.ifError(success.error);assert.equal(success.lines.length,0);
 r.f.state.afterGraph=(kind,value)=>kind==='inspect'?{...value,data:{...value.data,is_valid:false,error:{code:190,subcode:459,message:CANARY}}}:value;
 const denied=await capture(()=>r.health(),{brokenSink:true});assert.ifError(denied.error);assert.equal(denied.result.data.healthy,false);
 assert.equal(denied.result.data.reason,'credential_revoked');assert.equal(denied.lines.length,0);
});
