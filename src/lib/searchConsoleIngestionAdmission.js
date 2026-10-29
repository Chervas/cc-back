'use strict';
// Constructor/import is inert. Dedicated SQL lease, never the application pool.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks');
const BASE='/etc/clinicaclick-search-console',FILE=BASE+'/staging.json';
const TYPES=Object.freeze(['web_recent','web_backfill','web_backfill_for_sites']);
const SHA=b=>crypto.createHash('sha256').update(b).digest('hex');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const LOCK='cc:sc:ingest:'+SHA('clinicaclick:staging').slice(0,32);
const SQL=Object.freeze({acquire:'SELECT GET_LOCK(?,0) AS acquired',release:'SELECT RELEASE_LOCK(?) AS released',
 owner:'SELECT @@server_uuid AS uuid,CONNECTION_ID() AS sid,DATABASE() AS db,IS_USED_LOCK(?) AS owner'});
function readControl({io=fs}={}){
 let ds;
 try{ds=io.lstatSync(BASE);}catch(e){if(e.code==='ENOENT')return{present:false,state:'OPEN',generation:null,sha256:null};throw e;}
 need(ds.isDirectory()&&!ds.isSymbolicLink()&&ds.uid===0&&ds.gid===1000&&(ds.mode&511)===488&&io.realpathSync(BASE)===BASE,'search_console_control_parent');
 for(const p of ['/','/etc']){const s=io.lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===0&&(s.mode&0o022)===0,'search_console_control_ancestor');}
 let fd;
 try{fd=io.openSync(FILE,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}catch(e){if(e.code==='ENOENT')return{present:false,state:'OPEN',generation:null,sha256:null};throw e;}
 try{
  const s=io.fstatSync(fd);need(s.isFile()&&s.uid===0&&s.gid===1000&&(s.mode&511)===416&&s.nlink===1&&s.size>0&&s.size<=16384,'search_console_control_file');
  const b=io.readFileSync(fd),end=io.fstatSync(fd),named=io.lstatSync(FILE),parent=io.lstatSync(BASE);
  need(b.length===s.size&&['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>s[k]===end[k]&&s[k]===named[k])&&parent.ino===ds.ino&&parent.dev===ds.dev&&parent.mode===ds.mode&&io.realpathSync(BASE)===BASE,'search_console_control_changed');
  const d=JSON.parse(b);need(Object.keys(d).sort().join(',')==='generation,runtime,schema,state'&&d.schema==='clinicaclick-sc-ingestion-admission/1'&&d.runtime==='staging'&&['OPEN','CLOSED'].includes(d.state)&&UUID.test(d.generation||''),'search_console_control_shape');
  return{present:true,state:d.state,generation:d.generation,sha256:SHA(b)};
 }finally{io.closeSync(fd);}
}
function primary(sequelize){return sequelize?.config?.database==='clinicaclick';}
function controlFor(sequelize,read=readControl){return primary(sequelize)?read():{present:false,state:'OPEN',generation:null,sha256:null,localBypass:true};}
function assertEnqueue(type,sequelize,read=readControl){if(TYPES.includes(type)&&primary(sequelize))need(controlFor(sequelize,read).state==='OPEN','search_console_ingestion_paused');}
function claimExclusions(sequelize,read=readControl){if(!primary(sequelize))return[];try{return read().state==='OPEN'?[]:[...TYPES];}catch{return[...TYPES];}}
const waiting=reason=>({status:'waiting',backoffMs:60000,reason,processed:0,report:{paused:true,providerCalls:0,scWrites:0}});

// Application admission only. Operational DDL/drain transports retain their
// independently reviewed exact engine binding; do not reuse this predicate there.
function isSupportedLeaseVersion(version){return typeof version==='string'&&version.length<=24&&/^8\.4\.(?:0|[1-9][0-9]*)/.exec(version)?.[0]===version;}

async function openDedicated(sequelize,{makeConnection=require('mysql2').createConnection}={}){
 const T=require('./schemaReleaseDatabase');
 const c=sequelize?.config,ssl=sequelize?.options?.dialectOptions?.ssl;
 need(c?.database===T.DATABASE&&c.host===T.HOST&&Number(c.port||3306)===3306&&c.username===T.USERS.staging&&typeof c.password==='string'&&c.password.length>=16&&ssl?.rejectUnauthorized===true&&ssl.verifyIdentity===true&&ssl.minVersion==='TLSv1.2'&&SHA(ssl.ca)===T.CA_SHA,'search_console_lease_configuration');
 let raw,observed=false,lost=false,resolveClose;const closed=new Promise(resolve=>{resolveClose=resolve;});
 async function close(){let timer;try{need(raw?.stream,'search_console_lease_close_unproven');raw.destroy();raw.stream.destroy();if(raw.config)raw.config.password='';await Promise.race([closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('search_console_lease_close_unproven')),8000);})]);need(observed&&raw.stream.destroyed,'search_console_lease_close_unproven');return{physicalCloseObserved:true,physicalStreamDestroyed:true};}finally{clearTimeout(timer);}}
 try{
  raw=makeConnection({host:T.HOST,port:3306,database:T.DATABASE,user:c.username,password:c.password,ssl:{...ssl},charset:'UTF8MB4_UNICODE_CI',multipleStatements:false,connectTimeout:5000});
  raw.stream.once('close',()=>{observed=true;lost=true;resolveClose();});raw.once('error',()=>{lost=true;});
  const p=raw.promise();await p.connect();let queue=Promise.resolve();
  function query(sql,values=[]){const operation=queue.then(async()=>{need(!lost&&!raw.stream.destroyed,'search_console_lease_transport_lost');const [rows]=await p.query({sql,values,timeout:5000});const [warnings]=await p.query({sql:'SHOW WARNINGS',timeout:5000});need(Array.isArray(warnings)&&warnings.length===0,'search_console_lease_warnings');return rows;});queue=operation.catch(()=>{});return operation;}
  const ids=await query('SELECT @@server_uuid AS uuid,@@version AS version,DATABASE() AS db,CONNECTION_ID() AS sid,CURRENT_USER() AS account');
  const id=ids[0];need(ids.length===1&&/^[a-f0-9-]{36}$/.test(id.uuid)&&isSupportedLeaseVersion(id.version)&&id.db===T.DATABASE&&Number(id.sid)===raw.threadId&&id.account===T.USERS.staging+'@%','search_console_lease_identity');
  const tls=await query(T.TLS_SQL),status=Object.fromEntries(tls.map(row=>[row.Variable_name,row.Value]));
  need(tls.length===2&&['TLSv1.2','TLSv1.3'].includes(status.Ssl_version)&&status.Ssl_cipher,'search_console_lease_tls');
  return{query,identity:{serverUuid:id.uuid,sessionId:Number(id.sid),database:id.db},alive:()=>!lost&&!raw.stream.destroyed,close};
 }catch(e){if(raw){try{e.closure=await close();}catch(closeError){throw Object.assign(Error('search_console_lease_close_unproven'),{code:'search_console_lease_close_unproven'});}}throw e;}
}
function createAdmission({read=readControl,connect=openDedicated,startWatch=(fn)=>setInterval(fn,2000),stopWatch=clearInterval}={}){
 const active=new AsyncLocalStorage();
 async function verify(ctx){
  need(ctx.active&&ctx.transport.alive(),'search_console_lease_transport_lost');
  const rows=await ctx.transport.query(SQL.owner,[LOCK]),r=rows[0],i=ctx.identity;
  need(rows.length===1&&r.uuid===i.serverUuid&&Number(r.sid)===i.sessionId&&Number(r.owner)===i.sessionId&&r.db===i.database,'search_console_lease_owner_changed');
  need(!ctx.lost,'search_console_lease_transport_lost');return true;
 }
 async function assertHeld(){const ctx=active.getStore();if(ctx?.localBypass)return true;need(ctx,'search_console_lease_required');return verify(ctx);}
 async function run(sequelize,work){
  if(!primary(sequelize))return active.run({localBypass:true},work);
  const nested=active.getStore();if(nested){await assertHeld();return work();}
  let before;try{before=read();}catch{return waiting('search_console_control_invalid');}
  if(before.state!=='OPEN')return waiting('search_console_ingestion_paused');
  let transport,ctx,timer,released=false;
  try{
   transport=await connect(sequelize);
   const rows=await transport.query(SQL.acquire,[LOCK]);
   if(rows.length!==1||Number(rows[0].acquired)!==1)return waiting('search_console_ingestion_busy');
   ctx={active:true,lost:false,transport,identity:Object.freeze({...transport.identity})};
   const after=read();
   if(after.state!=='OPEN'||after.generation!==before.generation||after.sha256!==before.sha256)return waiting('search_console_ingestion_admission_changed');
   await verify(ctx);
   // Losing the lease never races/settles the original handler early. It must
   // finish/abort its own awaited work, and every SC write boundary rechecks it.
   timer=startWatch(()=>{verify(ctx).catch(()=>{ctx.lost=true;});});timer?.unref?.();
   return await active.run(ctx,async()=>{const result=await work();await verify(ctx);return result;});
  }finally{
   if(timer)stopWatch(timer);
   if(ctx)ctx.active=false;
   if(transport){try{const rows=await transport.query(SQL.release,[LOCK]);released=Number(rows[0]?.released)===1;}catch{}finally{await transport.close();}}
   // Dedicated transports are always physically closed, including contention
   // and UNKNOWN RELEASE; nothing is returned to a pool or retried.
  }
 }
 return Object.freeze({run,assertHeld,assertEnqueue:(t,s)=>assertEnqueue(t,s,read),claimExclusions:s=>claimExclusions(s,read),readControl:read});
}
const application=createAdmission();

const DRAIN_ADAPTER=Object.freeze({readControl,SQL,LOCK});
const digest=x=>SHA(JSON.stringify(x));
const DRAIN_TABLES=['WebScDaily','WebScDailyAgg','WebScQueryDaily','ScAnalyticsProperties','ScAnalyticsQueries','ScAnalyticsPages','ScAnalyticsIngestBatches','ScAnalyticsStagedRows','ScAnalyticsStagedTotals','ScAnalyticsDaily','ScAnalyticsPropertyDaily','ScAnalyticsRankingDaily','ScAnalyticsCoverageDaily','ScAnalyticsMonthly','ScAnalyticsArchiveBatches'];
const DRAIN_SQL=Object.freeze({
 jobs:"SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(*) AS n FROM JobRequests WHERE type IN ('web_recent','web_backfill','web_backfill_for_sites') AND status='running'",
 sync:"SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(*) AS n FROM SyncLogs WHERE job_type IN ('web_sync','web_backfill') AND status='running'",
 instrument:"SELECT NAME,ENABLED FROM performance_schema.setup_instruments WHERE NAME='wait/lock/metadata/sql/mdl'",
 mdl:"SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(*) AS n FROM performance_schema.metadata_locks WHERE OBJECT_TYPE='TABLE' AND OBJECT_SCHEMA='clinicaclick' AND OBJECT_NAME IN ("+DRAIN_TABLES.map(name=>"'"+name+"'").join(',')+")"
});
async function acquireDrain({transport,readControl=DRAIN_ADAPTER.readControl,verifyRuntime,expectedRuntimeRefs,now=Date.now,pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),maxWaitMs=30000}={}){
 need(transport?.query&&transport?.alive&&transport?.close&&transport.identity?.database==='clinicaclick'&&Number.isSafeInteger(transport.identity.sessionId)&&typeof transport.identity.serverUuid==='string','search_console_drain_transport_required');
 need(Number.isSafeInteger(maxWaitMs)&&maxWaitMs>=1&&maxWaitMs<=30000&&Array.isArray(expectedRuntimeRefs)&&expectedRuntimeRefs.length>0&&typeof verifyRuntime==='function','search_console_drain_runtime_proof_required');
 const policy=readControl();need(policy.present===true&&policy.state==='CLOSED'&&policy.generation&&policy.sha256,'search_console_drain_closed_control_required');
 const expectedRuntimeDigest=digest(expectedRuntimeRefs),identity=Object.freeze({...transport.identity});let active=true,held=false,timer,invalid=false,latest,firstRuntime;
 async function assertPolicy(){const p=readControl();need(digest(p)===digest(policy),'search_console_drain_control_changed');need(transport.alive()&&!invalid,'search_console_drain_transport_lost');const runtime=await verifyRuntime();need(runtime?.schema==='clinicaclick-sc-admission-runtime-observation/1'&&Number.isSafeInteger(runtime.pid)&&runtime.pid>0&&/^[0-9]+$/.test(runtime.startTicks||'')&&digest(runtime.codeRefs)===expectedRuntimeDigest,'search_console_drain_runtime_changed');if(firstRuntime)need(firstRuntime.pid===runtime.pid&&firstRuntime.startTicks===runtime.startTicks,'search_console_drain_runtime_changed');else firstRuntime={pid:runtime.pid,startTicks:runtime.startTicks};return runtime;}
 async function owner(){await assertPolicy();const rows=await transport.query(DRAIN_ADAPTER.SQL.owner,[DRAIN_ADAPTER.LOCK]),r=rows[0],id=identity;need(rows.length===1&&r.uuid===id.serverUuid&&Number(r.sid)===id.sessionId&&Number(r.owner)===id.sessionId&&r.db===id.database,'search_console_drain_owner_changed');}
 async function counts(){const instrument=await transport.query(DRAIN_SQL.instrument);need(instrument.length===1&&instrument[0].NAME==='wait/lock/metadata/sql/mdl'&&instrument[0].ENABLED==='YES','search_console_drain_mdl_unobservable');const out={};for(const k of ['jobs','sync','mdl']){const rows=await transport.query(DRAIN_SQL[k]);need(rows.length===1&&/^(0|[1-9][0-9]*)$/.test(String(rows[0].n)),'search_console_drain_count_invalid');out[k]=Number(rows[0].n);}return out;}
 async function verify(){need(active&&held,'search_console_drain_not_held');await owner();const observed=await counts();need(Object.values(observed).every(n=>n===0),'search_console_drain_work_present');await owner();latest={schema:'clinicaclick-sc-ingestion-drain-observation/1',status:'DRAINED_LEASE_HELD',checkedAtEpochMs:now(),control:policy,identity,counts:observed,runtimeCodeRefs:expectedRuntimeRefs,scope:'ALL_STAGING_SC_INGESTION',unrelatedJobsPaused:false,receiptAuthorizesLaterMutation:false};return latest;}
 async function assertHeld(){
  need(active&&held,'search_console_drain_not_held');await owner();
  // After the initial genuine MDL0 drain, Root's own load/retire transaction
  // can legitimately hold SC MDL. Admission remains closed and the same SQL
  // lock/runtime/config/UUID/SID must still be held; no new app writer can enter.
  for(const k of ['jobs','sync']){const rows=await transport.query(DRAIN_SQL[k]);need(rows.length===1&&String(rows[0].n)==='0','search_console_drain_work_present');}
  await owner();return{status:'ADMISSION_CLOSED_AND_LEASE_HELD',identity,control:policy};
 }
 async function release(){if(!active)return;active=false;if(timer)clearInterval(timer);try{if(held&&transport.alive())await transport.query(DRAIN_ADAPTER.SQL.release,[DRAIN_ADAPTER.LOCK]);}finally{return transport.close();}}
 try{
  await assertPolicy();const deadline=now()+maxWaitMs;
  while(now()<deadline){const rows=await transport.query(DRAIN_ADAPTER.SQL.acquire,[DRAIN_ADAPTER.LOCK]);need(rows.length===1&&[0,1].includes(Number(rows[0].acquired)),'search_console_drain_acquire_unknown');if(Number(rows[0].acquired)===1){held=true;break;}await assertPolicy();await pause(250);}
  need(held,'search_console_drain_active_ingestion');
  // A failed/unknown old SQL operation can outlive its admission socket. Wait
  // for genuine native JobRequest/SyncLog settlement AND observable SC MDL0.
  while(now()<deadline){await owner();const c=await counts();if(Object.values(c).every(n=>n===0))break;await pause(250);}
  const observation=await verify();
  timer=setInterval(()=>{owner().catch(()=>{invalid=true;});},2000);timer.unref?.();
  return Object.freeze({observation,verify,verifyDrain:verify,assertHeld,release,isHeld:()=>active&&held&&!invalid&&transport.alive()});
 }catch(e){await release();throw e;}
}
module.exports={BASE,FILE,TYPES,LOCK,SQL,readControl,primary,controlFor,assertEnqueue,claimExclusions,waiting,isSupportedLeaseVersion,openDedicated,createAdmission,application,DRAIN_SQL,DRAIN_TABLES,acquireDrain};
