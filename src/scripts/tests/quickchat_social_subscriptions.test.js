'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const service = require('../../services/socialInboxSubscriptions.service');
const enrollmentId = randomUUID(), versionId = randomUUID();
const target = { clinicId: 72, channel: 'messenger', accountId: '401', pageId: '401' };
const env = { JOB_RUNTIME_NAMESPACE:'staging', META_SOCIAL_INBOX_ENABLED:'true' };
const data = { enrollmentId,versionId,clinicId:72,pageId:'401',__runtime_namespace:'staging' };
function setup(){
  let active={state:'active',flow_id:versionId},pointer=null,route={...target,enrollmentId},providerResult={available:true};
  const t={LOCK:{UPDATE:'UPDATE'}},calls=[];
  const db={sequelize:{transaction:fn=>fn(t)},JobRequest:{},MetaMarketingEnrollmentRequest:{findByPk:async(id,o)=>{assert.equal(id,enrollmentId);assert.equal(o.transaction,t);return active;}},MetaMarketingEffectiveCredential:{findByPk:async()=>pointer}};
  const opts={targets:[target],env,resolve:async(_db,identity,tx)=>{assert.equal(tx,t);assert.deepEqual(identity,{channel:'messenger',accountId:'401'});return route;},
    getProvider:()=>({subscribePage:async(r,v)=>{calls.push([r,v]);if(providerResult instanceof Error)throw providerResult;return providerResult;}})};
  return { db,t,opts,calls,setPointer:x=>{pointer=x;},setActive:x=>{active=x;},setRoute:x=>{route=x;},setResult:x=>{providerResult=x;} };
}

test('CRM commits a unique setup job with its enrollment or renewal, target clinic and effective version; preserves gateway ownership',async()=>{
  const f=setup(),jobs=[],targets=[target,{clinicId:99,channel:'messenger',accountId:'555',pageId:'555'},{clinicId:72,channel:'instagram',accountId:'501',pageId:'401'}];
  const grant={enrollment_id:enrollmentId,selected:[{kind:'facebook_page',id:'401'}],clinicIds:[72,73]};
  await service.enqueuePages(f.db,grant,versionId,f.t,{targets,env:{RUNTIME_ROLE:'gateway',JOB_RUNTIME_NAMESPACE:'gateway',AUTOMATIONS_V2_FALLBACK_RUNTIME_NAMESPACE:'staging'},enqueue:async(job,ctx)=>jobs.push([job,ctx])});
  assert.equal(jobs.length,1); const [job,ctx]=jobs[0];
  assert.equal(ctx.transaction,f.t);assert.equal(job.type,service.JOB);assert.deepEqual(job.payload,data);
  assert.equal(job.dedupeScope,[enrollmentId,versionId,'401'].join(':'));
  await service.enqueuePages(f.db,{...grant,clinicIds:[73]},versionId,f.t,{targets,env,enqueue:async()=>assert.fail('foreign target')});
});
test('the subscription job requires a fresh, unique Page to clinic mapping and the exact active consent version',async()=>{
  const f=setup(),run=()=>service.run(f.db,data,f.opts);
  assert.deepEqual(await run(),{subscribed:true});assert.equal(f.calls.length,1);
  f.setPointer({version_id:randomUUID()});assert.equal((await run()).reason,'credential_changed');
  f.setPointer({version_id:versionId});f.setRoute({...target,enrollmentId,clinicId:73});assert.equal((await run()).reason,'account_unassigned');
  f.setRoute(null);assert.equal((await run()).reason,'account_unassigned');f.setActive({state:'revoked'});assert.equal((await run()).reason,'enrollment_changed');
  assert.equal(f.calls.length,1);
});
test('disabled setup, wrong runtime, disabled grants, provider throttling and transient errors remain distinguishable',async()=>{
  const f=setup();const run=(p=data,opts=f.opts)=>service.run(f.db,p,opts);
  assert.equal((await run(data,{...f.opts,targets:[]})).reason,'social_target_disabled');
  await assert.rejects(run({...data,__runtime_namespace:'gateway'}),/social_job_scope/);assert.equal(f.calls.length,0);
  f.setResult({available:false,reason:'permission:pages_messaging'});assert.equal((await run()).reason,'permission:pages_messaging');
  f.setResult(Object.assign(Error(),{code:'rate_limited',retryAfterMs:4000}));assert.equal((await run()).backoffMs,4000);
  f.setResult(Error('transport unavailable'));await assert.rejects(run(),/transport unavailable/);
});

test('only Facebook Pages named in a single-clinic owner receipt and resolved by the current CRM mapping enqueue and subscribe', async()=>{
  const f=setup(),jobs=[], options={targets:[],env,confirmedPages:['401'],inventory:async()=>({routes:[target,{...target,pageId:'999',accountId:'999'}]}),enqueue:async(job)=>jobs.push(job)};
  const grant={enrollment_id:enrollmentId,scope_key:'clinic:72',selected:[{kind:'facebook_page',id:'401'}],clinicIds:[72]};
  await service.enqueuePages(f.db,grant,versionId,f.t,{...options,confirmedPages:undefined});
  assert.deepEqual(jobs,[]);
  await assert.rejects(service.enqueuePages(f.db,{...grant,scope_key:'group:29'},versionId,f.t,options),/social_job_scope/);
  await assert.rejects(service.enqueuePages(f.db,grant,versionId,f.t,{...options,confirmedPages:['999']}),/social_job_scope/);
  await service.enqueuePages(f.db,grant,versionId,f.t,options);
  assert.equal(jobs.length,1);
  assert.deepEqual(jobs[0].payload,{...data,singleClinic:true});
  const run=()=>service.run(f.db,jobs[0].payload,{...f.opts,targets:[]});
  f.setActive({state:'active',scope_key:'group:29',clinic_ids:'[72]',flow_id:versionId});
  assert.equal((await run()).reason,'social_target_disabled');
  f.setActive({state:'active',scope_key:'clinic:72',clinic_ids:'[72]',flow_id:versionId});
  assert.deepEqual(await run(),{subscribed:true});
  f.setPointer({version_id:randomUUID()});
  assert.equal((await run()).reason,'credential_changed');
  assert.equal(f.calls.length,1);
});
