'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{randomUUID}=require('node:crypto'),{performance}=require('node:perf_hooks');
const {fixture}=require('./google-first-runtime-fixture.cjs');
const R=require('../src/google-first-admission-main'),B=require('../../../../baseline/services/integrations-broker/src/google-first-admission-main');
const {BrokerStore}=require('../src/store'),{createFirstGoogleJournal}=require('../src/google-first-identity-journal');
const {createFirstGoogleProvider}=require('../src/google-first-identity-provider'),{createFirstGoogleIdentityOwner}=require('../src/google-first-identity-owner');
const {createFirstGoogleCredentialVault}=require('../src/google-first-identity-vault');
const measurements=[];
async function many(t,{runtime=R,promoted=false,uniqueApps=false}={}){
 const f=await fixture(t,{service:'search_console',runtime});
 const original=f.slot;
 f.config.scopes=Array.from({length:35},(_,i)=>({scopeKey:'clinic:'+(1001+i),clinicIds:[1001+i],services:['search_console']}));
 f.config.slots=f.config.scopes.map((scope,i)=>{
  const slot={...original,scopeKey:scope.scopeKey,secretArn:original.secretArn.replace('group-11-qA123z',scope.scopeKey.replace(':','-')+'-qA123z'),baselineVersion:randomUUID()};
  if(uniqueApps)slot.clientSecretArn=original.clientSecretArn.replace('fictitious-client-abcdef','fictitious-client-'+i+'-abcdef');
  f.base.state.records.set(slot.secretArn,new Map([[slot.baselineVersion,{body:JSON.stringify({version:1,provider:'google-first-empty-slot',connectionRef:'google-first:search_console:'+scope.scopeKey,scopeKey:scope.scopeKey,service:'search_console'}),stages:new Set(['AWSCURRENT'])}]]));
  if(uniqueApps)f.base.state.records.set(slot.clientSecretArn,new Map([[randomUUID(),{body:JSON.stringify({...f.base.app,clientId:'fictitious-'+i+'.apps.googleusercontent.com'}),stages:new Set(['AWSCURRENT'])}]]));
  return slot;
 });
 f.save();
 if(promoted){
  // Seed through the actual first provider/journal/vault, with closed SDK/HTTP
  // doubles. Startup has no provider exchanges or writes to perform afterward.
  await f.start();await f.stop();
  const store=new BrokerStore(f.config.stateFile),journal=createFirstGoogleJournal({store}),vault=createFirstGoogleCredentialVault({...f.base.config,client:f.base.client,slots:f.config.slots,redirectUri:f.config.redirectUri});
  const provider=createFirstGoogleProvider({http:f.deps.http}),owner=createFirstGoogleIdentityOwner({journal,provider,vault});
  try{for(const slot of f.config.slots){
   const proof={attemptId:randomUUID(),bindingDigest:'a'.repeat(64),service:'search_console',expiresAt:Date.now()+300000},who={principalId:f.config.policy.principals[0].id,tenantRef:slot.scopeKey,connectionRef:'google-first:'+proof.attemptId,assetRef:'google-oauth:search_console:'+slot.scopeKey};
   const begin=await owner.begin(proof,who);await owner.finish(proof,who,{state:new URL(begin.authorizationUrl).searchParams.get('state'),code:Buffer.from('FICTITIOUS_CODE_'+proof.attemptId)});
   const saved=journal.getPrivateState(proof,who),intent=saved.stageIntent;
   const plan={...proof,scopeKey:slot.scopeKey,slotDigest:intent.slotDigest,applicationVersion:saved.applicationVersion,version:intent.versionId,secretDigest:intent.digest,
    googleUserId:saved.metadata.googleUserId,clientId:saved.clientId,refreshTokenExpiresAt:saved.metadata.refreshTokenExpiresAt,baselineVersion:intent.baselineVersion,metadataDigest:intent.metadataDigest};
   await vault.activate(plan,()=>true);
  }}finally{owner.close();store.close();}
 }
 const send=f.base.client.send.bind(f.base.client);let active=0,peak=0,latency=0,calls=0,appCalls=0,done=0,hook=async()=>{};
 f.base.client.send=async(command,options)=>{
  const signal=options?.abortSignal;calls++;if(command.input.SecretId===original.clientSecretArn)appCalls++;
  assert(['DescribeSecretCommand','GetSecretValueCommand'].includes(command.constructor.name),'Startup must remain read-only');
  active++;peak=Math.max(peak,active);
  try{
   if(signal?.aborted)throw Error('FICTITIOUS_STARTUP_ABORT');
   if(latency)await new Promise((resolve,reject)=>{
    const cleanup=()=>signal?.removeEventListener('abort',abort),timer=setTimeout(()=>{cleanup();resolve();},latency);
    function abort(){clearTimeout(timer);cleanup();reject(Error('FICTITIOUS_STARTUP_ABORT'));}signal?.addEventListener('abort',abort,{once:true});
   });
   await hook(command);const value=await send(command,options);done++;return value;
  }finally{active--;}
 };
 f.httpCalls.length=0;f.base.state.calls.length=0;f.events.length=0;
 return{...f,set latency(v){latency=v;},set hook(fn){hook=fn;},get closed(){return f.closed;},get peak(){return peak;},get active(){return active;},get calls(){return calls;},get appCalls(){return appCalls;},get done(){return done;}};
}
for(const latency of [100,200])test('35 empty slots: actual baseline times out and bounded startup succeeds at '+latency+'ms per AWS call',async t=>{
 const old=await many(t,{runtime:B});old.latency=latency;let start=performance.now();await assert.rejects(old.start());
 const baseline={variant:'baseline',state:'empty',slots:35,latencyMs:latency,elapsedMs:Math.round(performance.now()-start),calls:old.calls,peak:old.peak,ready:false};
 assert(baseline.elapsedMs>=9500&&baseline.elapsedMs<13000);assert.equal(old.httpCalls.length,0);assert.equal(old.active,0);assert.equal(old.events.length,0);
 const next=await many(t);next.latency=latency;start=performance.now();await next.start();
 const candidate={variant:'candidate',state:'empty',slots:35,latencyMs:latency,elapsedMs:Math.round(performance.now()-start),calls:next.calls,peak:next.peak,ready:true};
 assert.equal(next.calls,74);assert.equal(next.appCalls,4);assert.equal(next.peak,2);assert.equal(next.httpCalls.length,0);assert.equal(next.puts(),0);
 measurements.push(baseline,candidate);t.diagnostic(JSON.stringify({baseline,candidate}));
});
test('35 actually promoted credentials retain every exact version/digest guard under simulated 200ms AWS latency',async t=>{
 const old=await many(t,{runtime:B,promoted:true});old.latency=200;const before=performance.now();await assert.rejects(old.start());
 const baseline={variant:'baseline',state:'promoted',slots:35,latencyMs:200,elapsedMs:Math.round(performance.now()-before),calls:old.calls,peak:old.peak,ready:false};
 assert.equal(old.active,0);assert.equal(old.httpCalls.length,0);assert.equal(old.events.length,0);measurements.push(baseline);
 const f=await many(t,{promoted:true});f.latency=200;const start=performance.now();await f.start();
 const result={variant:'candidate',state:'promoted',slots:35,latencyMs:200,elapsedMs:Math.round(performance.now()-start),calls:f.calls,peak:f.peak,ready:true};
 assert.equal(f.calls,144);assert.equal(f.appCalls,4);assert.equal(f.peak,2);assert.equal(f.active,0);assert.equal(f.httpCalls.length,0);assert.equal(f.puts(),0);
 measurements.push(result);t.diagnostic(JSON.stringify({baseline,candidate:result}));
});
test('distinct applications are never merged and unique slots keep their own application checks',async t=>{
 const f=await many(t,{uniqueApps:true});await f.start();assert.equal(f.calls,140);assert.equal(f.peak,2);assert.equal(f.httpCalls.length,0);
});
test('one incompatible slot fails shut before listen, journal interruption and audit drain, and drains concurrent probes',async t=>{
 const f=await many(t);const slot=f.config.slots[7],versions=f.base.state.records.get(slot.secretArn);versions.get(slot.baselineVersion).body=JSON.stringify({foreign:true});
 f.latency=2;await assert.rejects(f.start());assert.equal(f.active,0);assert.equal(f.closed,1);assert.equal(f.httpCalls.length,0);assert.equal(f.events.length,0);
});
test('a shared application changed during the startup sweep is rejected by final metadata revalidation',async t=>{
 const f=await many(t),app=f.base.state.records.get(f.slot.clientSecretArn);let switched=false;
 f.hook=async command=>{if(!switched&&command.input.SecretId===f.config.slots[20].secretArn){switched=true;for(const v of app.values())v.stages.clear();app.set(randomUUID(),{body:JSON.stringify(f.base.app),stages:new Set(['AWSCURRENT'])});}};
 await assert.rejects(f.start(),{code:'secret_version_changed'});assert.equal(switched,true);assert.equal(f.active,0);assert.equal(f.events.length,0);assert.equal(f.httpCalls.length,0);
});
test('each promoted slot still rejects a wrong current version, digest or journal application version',async t=>{
 for(const variant of ['current-version','digest','app-version'])await t.test(variant,async t=>{
  const f=await many(t,{promoted:true}),slot=f.config.slots[9],versions=f.base.state.records.get(slot.secretArn);
  const entry=[...versions].find(([,row])=>row.stages.has('AWSCURRENT'));
  if(variant==='current-version'){entry[1].stages.clear();versions.set(randomUUID(),{body:entry[1].body,stages:new Set(['AWSCURRENT'])});}
  else if(variant==='digest')entry[1].body=JSON.stringify({...JSON.parse(entry[1].body),refreshToken:'FICTITIOUS_TAMPERED_REFRESH'});
  else{
   const store=new BrokerStore(f.config.stateFile);store.db.prepare('UPDATE google_first_identity_journal_v1 SET application_version=? WHERE asset=?').run(randomUUID(),'google-oauth:search_console:'+slot.scopeKey);store.close();
  }
  await assert.rejects(f.start());assert.equal(f.active,0);assert.equal(f.events.length,0);assert.equal(f.httpCalls.length,0);
 });
});
test('helper caches only public projection, never enumerates/retains application secret fields, and observes cancellation',async()=>{
 const slots=Array.from({length:35},(_,i)=>({scopeKey:'clinic:'+(i+1),service:'search_console',clientSecretArn:'same',secretArn:'slot'+i}));
 let apps=0,active=0,peak=0,slotsSeen=0;
 const secrets={async application(){apps++;return{clientId:'FICTITIOUS_PUBLIC_ID',secretVersion:'v1',get clientSecret(){throw Error('STARTUP_MUST_NOT_ACCESS_SECRET');}};},
  async assertFirstSlot(){active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));slotsSeen++;active--;}};
 await R.probeStartupSlots({config:{slots},store:{},secrets,vault:{},signal:new AbortController().signal});
 assert.equal(apps,2);assert.equal(slotsSeen,35);assert.equal(peak,2);
 const aborted=new AbortController();aborted.abort();slotsSeen=0;
 await assert.rejects(R.probeStartupSlots({config:{slots},store:{},secrets,vault:{},signal:aborted.signal}),{code:'secret_unavailable'});assert.equal(slotsSeen,0);
 let started=0,stopped=0;const timeout=AbortSignal.timeout(5);
 await assert.rejects(R.probeStartupSlots({config:{slots},store:{},secrets:{...secrets,async assertFirstSlot(_binding,_slot,signal){started++;await new Promise((_,reject)=>{
  const keepAlive=setTimeout(()=>reject(Error('FIXTURE_ABORT_NOT_HONORED')),1000);signal.addEventListener('abort',()=>{clearTimeout(keepAlive);stopped++;reject(Error('FICTITIOUS_SDK_ABORT'));},{once:true});
 });}},vault:{},signal:timeout}));
 assert.equal(started,2);assert.equal(stopped,2);
 assert.equal(R.STARTUP_CONCURRENCY,2);assert.equal(R.STARTUP_TIMEOUT_MS,30000);assert.equal(R.MAX_ACTIVE,B.MAX_ACTIVE);assert.equal(R.MAX_PER_MINUTE,B.MAX_PER_MINUTE);
});
test.after(()=>{if(process.env.PRIVATE_STARTUP_MEASUREMENT_FILE)fs.writeFileSync(process.env.PRIVATE_STARTUP_MEASUREMENT_FILE,JSON.stringify(measurements,null,2)+'\n',{mode:0o600});});
