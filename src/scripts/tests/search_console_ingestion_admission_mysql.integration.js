'use strict';
// Owned ephemeral engine ONLY: no app bootstrap, TLS/RDS or provider calls.
const assert=require('node:assert/strict');
const mysql=require('mysql2');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const A=require('../../lib/searchConsoleIngestionAdmission'),D={SQL:A.DRAIN_SQL,acquireDrain:A.acquireDrain};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function qualify(){
 await withIsolatedCampaignMysql(async({sql,report})=>{
  const rows=(await sql.query('SELECT @@datadir AS datadir,@@skip_networking AS isolated,@@log_bin AS binlog'))[0];
  assert(rows[0].datadir.startsWith(report.root+'/data'));assert.equal(Number(rows[0].isolated),1);assert.equal(Number(rows[0].binlog),0);
  // This schema is newly created on THIS owned UDS-only engine. Its identifiers
  // match production SQL; none of the data or connections comes from production.
  await sql.query('CREATE DATABASE clinicaclick');
  for(const ddl of ['CREATE TABLE clinicaclick.JobRequests(id INT PRIMARY KEY,type VARCHAR(80),status VARCHAR(16)) ENGINE=InnoDB',
   'CREATE TABLE clinicaclick.SyncLogs(id INT PRIMARY KEY,job_type VARCHAR(50),status VARCHAR(16)) ENGINE=InnoDB',
   'CREATE TABLE clinicaclick.WebScDaily(id INT PRIMARY KEY,n INT) ENGINE=InnoDB'])await sql.query(ddl);
  const instrument=(await sql.query(D.SQL.instrument))[0];assert.equal(instrument.length,1);
  if(instrument[0].ENABLED!=='YES')await sql.query("UPDATE performance_schema.setup_instruments SET ENABLED='YES' WHERE NAME='wait/lock/metadata/sql/mdl'");
  report.fixtureMdlInstrumentationBefore=instrument[0].ENABLED;
  const transports=[];
  async function own(){
   const raw=mysql.createConnection({socketPath:sql.options.dialectOptions.socketPath,user:'root',password:'',database:'clinicaclick',multipleStatements:false});
   let observed=false,alive=true,resolveClose;const closePromise=new Promise(resolve=>{resolveClose=resolve;});
   raw.stream.once('close',()=>{observed=true;alive=false;resolveClose();});raw.on('error',()=>{alive=false;});
   const p=raw.promise();await p.connect();let tail=Promise.resolve(),closing;
   async function query(text,values=[]){const next=tail.then(async()=>{assert(alive,'fixture transport closed');const [r]=await p.query({sql:text,values,timeout:5000});const [w]=await p.query({sql:'SHOW WARNINGS',timeout:5000});assert.equal(w.length,0);return r;});tail=next.catch(()=>{});return next;}
   const [id]=await query('SELECT @@server_uuid AS uuid,CONNECTION_ID() AS sid,DATABASE() AS db');
   const t={query,identity:Object.freeze({serverUuid:id.uuid,sessionId:Number(id.sid),database:id.db}),alive:()=>alive,
    close:()=>closing||=(async()=>{raw.destroy();raw.stream.destroy();let timer;try{await Promise.race([closePromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture_physical_close_unproven')),2000);})]);assert(observed&&raw.stream.destroyed);return{physicalCloseObserved:true,physicalStreamDestroyed:true};}finally{clearTimeout(timer);}})()};
   transports.push(t);return t;
  }
  let policy={present:true,state:'OPEN',generation:'10000000-0000-4000-8000-000000000001',sha256:'a'.repeat(64)},appConnection;
  const application=A.createAdmission({read:()=>policy,connect:async()=>appConnection=await own()});
  const codeRefs=[{path:'fixture_only_no_actual_runtime',sha256:'b'.repeat(64)}];
  const runtime=()=>({schema:'clinicaclick-sc-admission-runtime-observation/1',pid:12345,startTicks:'1',codeRefs});
  async function drain(t,options={}){return D.acquireDrain({transport:t,readControl:()=>policy,verifyRuntime:runtime,expectedRuntimeRefs:codeRefs,...options});}
  try{
   let release,entered;const ready=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
   const running=application.run({config:{database:'clinicaclick'}},async()=>{entered();await hold;await application.assertHeld();return 1;});
   await ready;policy={...policy,state:'CLOSED',generation:'10000000-0000-4000-8000-000000000002',sha256:'c'.repeat(64)};
   const second=await own();const lock=(await second.query(A.SQL.acquire,[A.LOCK]))[0];assert.equal(Number(lock.acquired),0);
   await assert.rejects(drain(second,{maxWaitMs:300}),/search_console_drain_active_ingestion/);
   release();assert.equal(await running,1);
   report.checks.push('Two real connections contend; existing admitted work finishes; owned physical close releases its lock');

   const observer=await own(),h=await drain(observer);assert.equal(h.observation.counts.jobs,0);assert.equal(h.observation.counts.mdl,0);
   const writer=await own();await writer.query('START TRANSACTION');await writer.query('INSERT INTO WebScDaily(id,n) VALUES(1,1)');
   await assert.rejects(h.verifyDrain(),/search_console_drain_work_present/);
   assert.equal((await h.assertHeld()).status,'ADMISSION_CLOSED_AND_LEASE_HELD');
   await writer.query('ROLLBACK');assert.equal((await h.verifyDrain()).counts.mdl,0);await h.release();await writer.close();
   report.checks.push('Real SC MDL blocks initial/full drain; legitimate Root transaction retains admission lease; rollback restores MDL0');

   const direct=await own();await direct.query("INSERT INTO SyncLogs(id,job_type,status) VALUES(1,'web_sync','running')");
   await assert.rejects(drain(await own(),{maxWaitMs:300}),/search_console_drain_work_present/);
   await direct.query("UPDATE SyncLogs SET status='completed' WHERE id=1");await direct.close();
   report.checks.push('Real direct SyncLog running blocks DRAINED without a JobRequest');

   policy={...policy,state:'OPEN',generation:'10000000-0000-4000-8000-000000000003',sha256:'d'.repeat(64)};
   let resume,started;const start=new Promise(resolve=>{started=resolve;}),wait=new Promise(resolve=>{resume=resolve;});
   const dying=application.run({config:{database:'clinicaclick'}},async()=>{started();await wait;await application.assertHeld();});
   await start;await appConnection.close();resume();await assert.rejects(dying,/search_console_lease_transport_lost/);
   policy={...policy,state:'CLOSED',generation:'10000000-0000-4000-8000-000000000004',sha256:'e'.repeat(64)};
   const recovered=await drain(await own());assert(recovered.isHeld());await recovered.release();
   report.checks.push('Physical admission connection death aborts awaited guard; no original handler early settlement; fresh real owner can drain after closure');
  }finally{
   for(const t of transports)await t.close();
   report.ownedSqlTransports=transports.length;report.allOwnedCloseEventsObserved=true;
  }
 },{performanceSchema:true});
}
if(require.main===module&&process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST!=='1')process.stdout.write(JSON.stringify({status:'SKIPPED',reason:'Explicit owned-fixture flag required'})+'\n');
else if(require.main===module)qualify().catch(error=>{process.stderr.write(String(error.stack)+'\n');process.exitCode=1;});
module.exports={qualify};
