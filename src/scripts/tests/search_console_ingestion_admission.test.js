'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const A=require('../../lib/searchConsoleIngestionAdmission'),D={SQL:A.DRAIN_SQL,acquireDrain:A.acquireDrain};
const path=require('node:path'),{createRequire}=require('node:module');
const fixtureFile=path.join(__dirname,'web_search_console_ingest.test.js'),fixtureModule={exports:{}};
const fixtureRequire=createRequire(fixtureFile);
vm.runInNewContext(fs.readFileSync(fixtureFile,'utf8'),{module:fixtureModule,exports:fixtureModule.exports,process,console,Buffer,URL,URLSearchParams,Date,structuredClone,setTimeout,clearTimeout,require:name=>name==='node:test'?(()=>{}):fixtureRequire(name)},{filename:fixtureFile});
const {jobsFixture}=fixtureModule.exports;
const S={config:{database:'clinicaclick'}},uuid='10000000-0000-4000-8000-000000000001';
const state=(mode='OPEN',n=1)=>({present:true,state:mode,generation:`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,sha256:String(n).repeat(64)});
function transport(){const t={identity:{serverUuid:uuid,sessionId:91,database:'clinicaclick'},live:true,closed:0,acquired:1,queries:[],jobs:0,sync:0,mdl:0,instrument:'YES',ownerId:91,ownerUuid:uuid};
 t.alive=()=>t.live;t.close=async()=>{t.live=false;t.closed++;return{physicalCloseObserved:true,physicalStreamDestroyed:true};};
 t.query=async(sql,values)=>{t.queries.push(sql);if(sql===A.SQL.acquire)return[{acquired:t.acquired}];if(sql===A.SQL.release)return[{released:1}];if(sql===A.SQL.owner)return[{uuid:t.ownerUuid,sid:t.identity.sessionId,owner:t.ownerId,db:'clinicaclick'}];if(sql===D.SQL.instrument)return[{NAME:'wait/lock/metadata/sql/mdl',ENABLED:t.instrument}];for(const k of ['jobs','sync','mdl'])if(sql===D.SQL[k])return[{n:String(t[k])}];throw Error('UNEXPECTED_SQL');};return t;}
function app(read,t=transport()){const watchers=[];const c=A.createAdmission({read,connect:async()=>t,startWatch:fn=>{watchers.push(fn);return 1;},stopWatch:()=>{}});return{c,t,watchers};}
const codeRefs=[{path:'src/jobs/sync.jobs.js',sha256:'a'.repeat(64)}];
const runtime=()=>({schema:'clinicaclick-sc-admission-runtime-observation/1',pid:901,startTicks:'123',codeRefs});
test('closed/corrupt config excludes ONLY SC claims/enqueues; WA/other/DEV never read it',()=>{
 let reads=0;const read=()=>{reads++;return state('CLOSED');};
 for(const type of A.TYPES)assert.throws(()=>A.assertEnqueue(type,S,read),/search_console_ingestion_paused/);
 A.assertEnqueue('whatsapp_send',S,()=>assert.fail('WA read control'));A.assertEnqueue('analytics_recent',S,()=>assert.fail('GA read control'));
 assert.deepEqual(A.claimExclusions(S,()=>{throw Error('bad config');}),A.TYPES);
 assert.deepEqual(A.claimExclusions({config:{database:'clinicaclick_dev_isolated'}},()=>assert.fail('DEV read control')),[]);assert.equal(reads,3);
});
test('genuine FD control parser enforces Root:ubuntu0640/0750, nlink1/noFollow and strict generation shape',()=>{
 const content=Buffer.from(JSON.stringify({schema:'clinicaclick-sc-ingestion-admission/1',runtime:'staging',state:'CLOSED',generation:state().generation}));
 const dir={dev:1,ino:1,uid:0,gid:1000,mode:0o40750,isDirectory:()=>true,isSymbolicLink:()=>false};
 const file={dev:1,ino:2,uid:0,gid:1000,mode:0o100640,nlink:1,size:content.length,mtimeMs:1,ctimeMs:1,isFile:()=>true};
 let closed=0;const io={lstatSync:p=>p===A.BASE?dir:p===A.FILE?file:{...dir,gid:0,mode:0o40755},realpathSync:p=>p,openSync:(p,flags)=>{assert(flags&fs.constants.O_NOFOLLOW);return 1;},fstatSync:()=>file,readFileSync:()=>content,closeSync:()=>closed++};
 assert.equal(A.readControl({io}).state,'CLOSED');assert.equal(closed,1);
 for(const patch of [{uid:1000},{gid:0},{mode:0o100660},{nlink:2}]){const original={...file};Object.assign(file,patch);assert.throws(()=>A.readControl({io}),/search_console_control_file/);Object.assign(file,original);}
 dir.mode=0o40770;assert.throws(()=>A.readControl({io}),/search_console_control_parent/);
});
test('OPEN to CLOSED before/after lock never calls provider/body; contended lease closes physical owner',async()=>{
 let calls=0;let n=0;const a=app(()=>++n===1?state():state('CLOSED',2));
 assert.equal((await a.c.run(S,async()=>calls++)).status,'waiting');assert.equal(calls,0);assert.equal(a.t.closed,1);
 const b=app(()=>state('CLOSED'));assert.equal((await b.c.run(S,async()=>calls++)).status,'waiting');assert.equal(b.t.queries.length,0);
 const c=app(()=>state());c.t.acquired=0;assert.equal((await c.c.run(S,async()=>calls++)).status,'waiting');assert.equal(c.t.closed,1);
});
test('admitted existing job can finish after CLOSED; nested backfill takes exactly one dedicated lease',async()=>{
 let policy=state(),connections=0;const t=transport();const a=A.createAdmission({read:()=>policy,connect:async()=>{connections++;return t;},startWatch:()=>1,stopWatch:()=>{}});
 const result=await a.run(S,async()=>{policy=state('CLOSED',2);return a.run(S,async()=>{await a.assertHeld();return 7;});});
 assert.equal(result,7);assert.equal(connections,1);assert.equal(t.queries.filter(q=>q===A.SQL.acquire).length,1);assert.equal(t.closed,1);
});
test('watchdog loss cannot settle still-running original work; UUID/SID changes invalidate guard',async()=>{
 const f=app(()=>state());let release;const pending=new Promise(r=>release=r);let done=false;
 const run=f.c.run(S,async()=>{await pending;await f.c.assertHeld();return 1;}).finally(()=>{done=true;});
 await new Promise(r=>setImmediate(r));f.t.live=false;await f.watchers[0]();await new Promise(r=>setImmediate(r));assert.equal(done,false);
 release();await assert.rejects(run,/search_console_lease_transport_lost/);assert.equal(f.t.closed,1);
 for(const key of ['ownerUuid','ownerId']){const g=app(()=>state());await assert.rejects(g.c.run(S,async()=>{g.t[key]=key==='ownerUuid'?'different':92;await g.c.assertHeld();}),/search_console_lease_owner_changed/);}
});
test('genuine executeWebSync and both backfill entries defer without SC/PSI/provider writes when CLOSED',async()=>{
 const f=app(()=>state('CLOSED')),j=jobsFixture({admission:f.c});j.models.sequelize.config={database:'clinicaclick'};
 for(const invoke of [()=>j.jobs.executeWebSync(),()=>j.jobs.executeWebBackfill(),()=>j.jobs.executeWebBackfillForSites([{clinicId:71,siteUrl:'https://example.invalid/'}])])assert.equal((await invoke()).status,'waiting');
 assert.equal(j.state.calls.length,0);assert.equal(j.state.tables.query.size,0);assert.equal(j.state.tables.daily.size,0);assert.equal(f.t.queries.length,0);
});
test('native cron/manual SC observations report paused, never completed or queued, and do not enqueue',async()=>{
 const f=app(()=>state('CLOSED')),j=jobsFixture({admission:f.c});j.models.sequelize.config={database:'clinicaclick'};
 const old=new Date('2020-01-01'),handler=()=>j.jobs.enqueueScheduledJob('webSync');
 const entry={handler,status:'running',lastExecution:old};j.jobs.jobs.set('webSync',entry);
 assert.equal((await j.jobs.runJob('webSync')).status,'paused');assert.equal(entry.status,'paused');assert.equal(entry.lastExecution,old);
 entry.status='running';assert.equal((await j.jobs.executeWithRetry('webSync',handler)).status,'paused');assert.equal(entry.status,'paused');assert.equal(entry.lastExecution,old);assert.equal(j.state.calls.length,0);
});
test('genuine claimNextJob/claimById preserve queued SC attempt count while allowing another native type',async()=>{
 const {Op}=require('sequelize');const tasks=[{id:1,type:'web_recent',status:'queued',attempts:0},{id:2,type:'whatsapp_owned_fixture',status:'queued',attempts:0}];let updates=0;
 const transaction={LOCK:{UPDATE:'UPDATE'}};
 const sequelize={config:{database:'clinicaclick'},literal:value=>value,where:(...args)=>args,transaction:async(_options,fn)=>fn(transaction)};
 const model={findOne:async options=>{const clauses=options.where[Op.and]||[],excluded=clauses.find(row=>row.type?.[Op.notIn])?.type[Op.notIn]||[];return tasks.find(row=>row.status==='queued'&&!excluded.includes(row.type))||null;},findByPk:async id=>tasks.find(row=>row.id===id),update:async(patch,options)=>{updates++;const row=tasks.find(row=>row.id===options.where.id);Object.assign(row,patch);return[1];}};
 const module={exports:{}};const admission=A.createAdmission({read:()=>state('CLOSED')});
 const sandbox={module,exports:module.exports,process:{env:{JOB_RUNTIME_NAMESPACE:'staging'},cwd:()=>'/fixture'},console,setTimeout,Date,Buffer,require:name=>{
  if(name==='../lib/searchConsoleIngestionAdmission')return{application:admission};if(name==='sequelize')return require('sequelize');if(name==='crypto')return require('node:crypto');if(name==='../../models')return{JobRequest:model,sequelize,Sequelize:{Transaction:{ISOLATION_LEVELS:{READ_COMMITTED:'READ COMMITTED',SERIALIZABLE:'SERIALIZABLE'}}}};
  if(name==='../lib/gatewayJobOwnership')return{resolveEnqueueRuntimeNamespace:(current,requested)=>requested||current};throw Error('unexpected_dependency:'+name);
 }};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../services/jobRequests.service.js'),'utf8'),sandbox,{filename:'jobRequests.candidate.js'});
 assert.equal(await module.exports.claimJobById(1),null);assert.equal(tasks[0].attempts,0);assert.equal(updates,0);
 const job=await module.exports.claimNextJob(['normal'],A.TYPES.concat('whatsapp_owned_fixture'));assert.equal(job.id,2);assert.equal(tasks[0].attempts,0);assert.equal(updates,1);
});
test('drain requires present CLOSED config and acquired SQL lock, native/MDL0, actual runtime/code shape',async()=>{
 let time=0;const t=transport(),read=()=>state('CLOSED');
 await assert.rejects(D.acquireDrain({transport:t,readControl:()=>({present:false,state:'OPEN'}),verifyRuntime:runtime,expectedRuntimeRefs:codeRefs}),/search_console_drain_closed_control_required/);
 t.jobs=1;await assert.rejects(D.acquireDrain({transport:t,readControl:read,verifyRuntime:runtime,expectedRuntimeRefs:codeRefs,now:()=>time,pause:async()=>{time+=250;},maxWaitMs:500}),/search_console_drain_work_present/);assert.equal(t.closed,1);
 const clean=transport(),handle=await D.acquireDrain({transport:clean,readControl:read,verifyRuntime:runtime,expectedRuntimeRefs:codeRefs});
 assert.equal(handle.observation.status,'DRAINED_LEASE_HELD');assert.equal(handle.observation.receiptAuthorizesLaterMutation,false);assert.equal(handle.isHeld(),true);
 clean.mdl=1;assert.equal((await handle.assertHeld()).status,'ADMISSION_CLOSED_AND_LEASE_HELD');await assert.rejects(handle.verifyDrain(),/search_console_drain_work_present/);clean.mdl=0;
 await handle.release();assert.equal(clean.closed,1);assert.equal(handle.isHeld(),false);await assert.rejects(handle.verify(),/search_console_drain_not_held/);
});
test('config generation/bytes, runtime PID/ticks, UUID/SID and lost transport invalidate DRAINED',async()=>{
 for(const kind of ['policy','runtime','uuid','sid','lost']){
  const t=transport();let policy=state('CLOSED'),proof=runtime();
  const h=await D.acquireDrain({transport:t,readControl:()=>policy,verifyRuntime:()=>proof,expectedRuntimeRefs:codeRefs});
  if(kind==='policy')policy=state('CLOSED',2);if(kind==='runtime')proof={...proof,startTicks:'124'};if(kind==='uuid')t.ownerUuid='different';if(kind==='sid')t.identity.sessionId=92;if(kind==='lost')t.live=false;
  await assert.rejects(h.verify(),/search_console_drain_(?:control_changed|runtime_changed|owner_changed|transport_lost)/);await h.release();
 }
});
test('unobservable MDL or direct running SyncLog never qualifies as DRAINED',async()=>{
 for(const kind of ['instrument','sync','mdl']){const t=transport();if(kind==='instrument')t.instrument='NO';else t[kind]=1;let n=0;
  await assert.rejects(D.acquireDrain({transport:t,readControl:()=>state('CLOSED'),verifyRuntime:runtime,expectedRuntimeRefs:codeRefs,maxWaitMs:1,now:()=>n,pause:async()=>{n+=2;}}),/search_console_drain_(?:mdl_unobservable|work_present)/);assert.equal(t.closed,1);
 }
});
test('dedicated driver observes physical close EVENT and never reserves app pool; handshake failure closes too',async()=>{
 const ca=Buffer.from('FICTITIOUS_CA_FOR_INJECTED_PROFILE'),T={HOST:'fixture.invalid',DATABASE:'clinicaclick',USERS:{staging:'fixture_app'},VERSION:'8.4.11',CA_SHA:require('node:crypto').createHash('sha256').update(ca).digest('hex'),TLS_SQL:'SHOW SESSION STATUS WHERE fixture=1'};let made=0,raw;
 const profileModule={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../lib/searchConsoleIngestionAdmission.js'),'utf8'),{module:profileModule,exports:profileModule.exports,process,Buffer,setTimeout,clearTimeout,setInterval,clearInterval,require:name=>name==='./schemaReleaseDatabase'?T:require(name)},{filename:'admission.injected-profile.js'});const dedicated=profileModule.exports.openDedicated;
 function make(config,{fail=false,emit=true}={}){made++;const stream=new EventEmitter();stream.destroyed=false;stream.destroy=()=>{stream.destroyed=true;if(emit)queueMicrotask(()=>stream.emit('close'));};raw=new EventEmitter();Object.assign(raw,{threadId:91,config,stream,destroy(){stream.destroy();}});raw.promise=()=>({connect:async()=>{if(fail)throw Error('fixture_handshake_failed');},query:async({sql})=>{
  if(sql==='SHOW WARNINGS')return[[]];if(sql===T.TLS_SQL)return[[{Variable_name:'Ssl_version',Value:'TLSv1.3'},{Variable_name:'Ssl_cipher',Value:'fixture'}]];return[[{uuid,version:T.VERSION,db:T.DATABASE,sid:91,account:T.USERS.staging+'@%'}]];
 }});return raw;}
 const sequelize={config:{database:T.DATABASE,host:T.HOST,port:3306,username:T.USERS.staging,password:'fictional_password_123'},options:{dialectOptions:{ssl:{rejectUnauthorized:true,verifyIdentity:true,minVersion:'TLSv1.2',ca}}},connectionManager:new Proxy({},{get(){assert.fail('pool touched');}})};
 const own=await dedicated(sequelize,{makeConnection:make});assert.equal((await own.close()).physicalCloseObserved,true);assert.equal(made,1);assert.equal(raw.config.password,'');
 await assert.rejects(dedicated(sequelize,{makeConnection:cfg=>make(cfg,{fail:true})}),e=>e.message==='fixture_handshake_failed'&&e.closure.physicalCloseObserved===true);assert.equal(raw.stream.destroyed,true);
});
test('application lease version predicate admits canonical MySQL8.4 patch releases and rejects other families or filler',()=>{
 for(const version of ['8.4.0','8.4.11','8.4.12','8.4.123'])assert.equal(A.isSupportedLeaseVersion(version),true,version);
 for(const version of ['8.0.42','8.5.0','9.0.0','8.4','8.4.01',' 8.4.12','8.4.12 ','8.4.12-log','MySQL8.4.12','8.4.12\n','8.4.-1','8.4.1.2',8.412,null,undefined])assert.equal(A.isSupportedLeaseVersion(version),false,String(version));
});
test('genuine dedicated application handshake accepts8.4.12 despite old operational pin and closes rejected engines',async()=>{
 const ca=Buffer.from('FICTIONAL_CA_FOR_FAMILY_CASE'),T={HOST:'fixture.invalid',DATABASE:'clinicaclick',USERS:{staging:'fixture_app'},VERSION:'8.4.11',CA_SHA:require('node:crypto').createHash('sha256').update(ca).digest('hex'),TLS_SQL:'SHOW SESSION STATUS WHERE fixture=1'};
 const m={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../lib/searchConsoleIngestionAdmission.js'),'utf8'),{module:m,exports:m.exports,process,Buffer,setTimeout,clearTimeout,setInterval,clearInterval,require:name=>name==='./schemaReleaseDatabase'?T:require(name)},{filename:'family-profile.fixture.js'});
 const sequelize={config:{database:T.DATABASE,host:T.HOST,port:3306,username:T.USERS.staging,password:'fictitious_password_123'},options:{dialectOptions:{ssl:{rejectUnauthorized:true,verifyIdentity:true,minVersion:'TLSv1.2',ca}}}};
 for(const version of ['8.4.11','8.4.12','8.0.42','8.5.0','8.4.12-junk']){
  let raw;const makeConnection=config=>{const stream=new EventEmitter();stream.destroyed=false;stream.destroy=()=>{stream.destroyed=true;queueMicrotask(()=>stream.emit('close'));};raw=new EventEmitter();Object.assign(raw,{threadId:91,config,stream,destroy(){stream.destroy();}});raw.promise=()=>({connect:async()=>{},query:async({sql})=>sql==='SHOW WARNINGS'?[[]]:sql===T.TLS_SQL?[[{Variable_name:'Ssl_version',Value:'TLSv1.3'},{Variable_name:'Ssl_cipher',Value:'fixture'}]]:[[{uuid,version,db:T.DATABASE,sid:91,account:T.USERS.staging+'@%'}]]});return raw;};
  if(version==='8.4.11'||version==='8.4.12'){const t=await m.exports.openDedicated(sequelize,{makeConnection});assert.equal(t.identity.serverUuid,uuid);assert.equal(t.identity.sessionId,91);assert.equal((await t.close()).physicalCloseObserved,true);}
  else await assert.rejects(m.exports.openDedicated(sequelize,{makeConnection}),e=>e.message==='search_console_lease_identity'&&e.closure.physicalCloseObserved===true);
  assert.equal(raw.stream.destroyed,true);assert.equal(raw.config.password,'');
 }
});
test('operational public schema/drain binding retains exact reviewed engine rather than the application family predicate',()=>{
 const T=require('../../lib/schemaReleaseDatabase'),binding={schema:'clinicaclick-rds-schema-check-binding/1',rootReviewed:true,runtime:'staging',checkedAtEpochMs:1,expiresAtEpochMs:300001,host:T.HOST,port:3306,database:T.DATABASE,serverUuid:uuid,engineVersion:'8.4.11',caSha256:T.CA_SHA,expectedUsername:T.USERS.staging};
 assert.equal(T.VERSION,'8.4.11');assert.equal(T.validateBinding(binding,'staging',100).engineVersion,'8.4.11');assert.equal(A.isSupportedLeaseVersion('8.4.12'),true);
 assert.throws(()=>T.validateBinding({...binding,engineVersion:'8.4.12'},'staging',100),/schema_public_binding_identity/);
});
