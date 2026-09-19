'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn,execFile}=require('node:child_process'),{promisify}=require('node:util'),crypto=require('node:crypto');
const mysql=require('mysql2/promise'),Redis=require('ioredis'),{Queue,Worker}=require('bullmq');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const original=require('./fixtures/meta_pre_migration_schema.json'),schema=require('../../lib/securitySchemaContract');
const meta=require('../../lib/metaClinicalSchemaRelease'),contract=require('../../../ops/security/schema-contract.json');
const {clinicalCutDatabaseCheck}=require('../../lib/clinicalCutDatabaseCheck');
const {pendingJobFingerprint}=require('../../lib/clinicalCutActivity');
const {observePm2Application}=require('../../lib/clinicalCutProcessIdentity');
const {runClinicalSchemaCut}=require('../../lib/clinicalSchemaCutCoordinator');
const {acquireClinicalJobRequestCutGate}=require('../../lib/clinicalJobRequestCutGate');
const {clinicalBullmqCutGate}=require('../../lib/clinicalBullmqCutGate');
const {encryptStream,verifyCipher}=require('../meta-clinical-schema-release');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async f=>{const deadline=Date.now()+15000;for(;;){const result=await f();if(result)return result;assert(Date.now()<deadline,'owned_fixture_wait_timeout');await delay(25);}};
test('complete cut binds real PM2/npm/Node, SQL admission, Redis ownership, encrypted backup and nine DDL without losing newly due jobs',async()=>{
 await withIsolatedCampaignMysql(async({sql,models,report,registerOwnedUnixSocket})=>{
  const source=path.resolve(__dirname,'../../..'),socket=path.join(report.root,'mysql.sock');
  const connect=()=>mysql.createConnection({socketPath:socket,user:'root',database:report.database});
  const withQuery=async fn=>{const c=await connect();try{return await fn(async(s,v=[])=>(await c.query({sql:s,values:v,timeout:10000}))[0],c);}finally{await c.end();}};
  await sql.query('ALTER DATABASE campaign_optimization_qa CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  for(const[t,id]of [['Usuarios','id_usuario'],['Clinicas','id_clinica'],['GruposClinicas','id_grupo']])await sql.query('CREATE TABLE '+t+' ('+id+' INT PRIMARY KEY) ENGINE=InnoDB');
  await sql.query('CREATE TABLE SequelizeMeta (name VARCHAR(255) PRIMARY KEY) ENGINE=InnoDB');
  for(const ddl of Object.values(original.ddl))await sql.query(ddl);
  await sql.query("INSERT INTO MetaConnections(id,metaUserId,accessToken,createdAt,updatedAt) VALUES(1,'qa','FICTITIOUS_TOKEN',NOW(),NOW())");
  await sql.query("INSERT INTO ClinicMetaAssets(id,metaConnectionId,metaAssetId,assetType,waAccessToken,isActive,createdAt,updatedAt) VALUES(1,1,'qa-wa','whatsapp_phone_number','FICTITIOUS_WA_TOKEN',0,NOW(),NOW())");
  models.Sequelize=require('sequelize');models.JobRequest=require('../../../models/jobrequest')(sql,models.Sequelize.DataTypes);await models.JobRequest.sync();
  await sql.query('CREATE TABLE EmailMessages (id INT PRIMARY KEY,status VARCHAR(20),job_request_id INT UNSIGNED NULL,FOREIGN KEY(job_request_id) REFERENCES JobRequests(id)) ENGINE=InnoDB');
  await sql.query('CREATE TABLE FlowExecutionsV2 (id INT PRIMARY KEY,status VARCHAR(20)) ENGINE=InnoDB');
  await sql.close();
  const migrations=meta.MIGRATIONS.map(name=>({name,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(source,'migrations',name))).digest('hex')}));
  const subset={version:1,tables:Object.fromEntries([...meta.TABLES,...meta.NEW_TABLES].map(n=>[n,contract.tables[n]])),migrations};
  const info={revision:'owned_bound_fixture',contractDigest:schema.digest(subset),contract:subset,migrations:Object.fromEntries(migrations.map(m=>[m.name,m.sha256]))};
  const plan=await withQuery(query=>meta.prepare({query,info,database:report.database}));
  const database=options=>clinicalCutDatabaseCheck({connect,plan,info,...options});
  const pm2Home=path.join(report.root,'pm2');fs.mkdirSync(pm2Home,{mode:0o700});
  const env={PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:process.env.HOME,PM2_HOME:pm2Home,PM2_SILENT:'true'};
  const pm2=async(args,cwd=report.root)=>(await promisify(execFile)(process.execPath,['/usr/lib/node_modules/pm2/bin/pm2',...args],{env,cwd,timeout:12000})).stdout.trim();
  const roots={},records={},queueObjects=[],gates=[],events=[],processActions=[];let redis,redisChild,redisExited,worker,providerCalls=0,sqlHeld=false,expectedPending,backupReceipt;
  const aux={id:'owned-auxiliary',state:'running',pid:10001};
  const token=crypto.randomUUID(),names=['outbound_whatsapp','webhook_whatsapp','whatsapp_template_create','whatsapp_template_sync','whatsapp_phone_sync','automation_defaults'];
  const oldPauses=[false,false,true,true,true,false,true,false,true,true,true,false];
  const inspect=async id=>id===aux.id?{state:aux.state,pid:aux.pid}:observePm2Application({rows:JSON.parse(await pm2(['jlist'])),id,root:roots[id]});
  const waitState=(id,state)=>until(async()=>{const now=await inspect(id);return now.state===state&&now;});
  try{
   const redisSocket=path.join(report.root,'redis.sock');
   redisChild=spawn('/usr/bin/redis-server',['--port','0','--unixsocket',redisSocket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',report.root],{stdio:'ignore'});
   redisExited=new Promise(resolve=>redisChild.once('exit',(code,signal)=>resolve({code,signal})));await until(()=>fs.existsSync(redisSocket));registerOwnedUnixSocket(redisSocket);
   redis=new Redis({path:redisSocket,maxRetriesPerRequest:null,retryStrategy:()=>null});await redis.ping();
   for(const prefix of ['qa-staging','qa-gateway'])for(const name of names){
    const q=new Queue(name,{prefix,connection:redis});await q.waitUntilReady();if(oldPauses[queueObjects.length])await q.pause();queueObjects.push(q);
    gates.push(clinicalBullmqCutGate({client:redis,prefix,name,token}));
   }
   worker=new Worker('outbound_whatsapp',async()=>{providerCalls++;return{fictitious:true};},{prefix:'qa-staging',connection:redis});await worker.waitUntilReady();
   for(const id of ['owned-api','owned-gateway']){
    const root=path.join(report.root,id);roots[id]=root;fs.mkdirSync(root);fs.mkdirSync(path.join(root,'src'));
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{start:'node src/app.js'}}));
    const config={source,socket,database:report.database,claim:id==='owned-api'};
    fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(config));
    fs.writeFileSync(path.join(root,'src/app.js'),`'use strict';
const fs=require('fs'),net=require('net'),cfg=require('../config.json'),original=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const v=Array.isArray(args[0])?args[0][0]:args[0];if(v?.path!==cfg.socket||v?.host||v?.port)throw Error('OWNED_CHILD_FOREIGN_SOCKET');return original.apply(this,args);};
global.fetch=()=>{throw Error('OWNED_CHILD_PROVIDER_FORBIDDEN');};
process.env.JOB_RUNTIME_NAMESPACE='staging';process.env.JOB_RUNTIME_CLAIM_UNSCOPED='false';
const S=require(cfg.source+'/node_modules/sequelize');const sequelize=new S.Sequelize({dialect:'mysql',username:'root',password:'',database:cfg.database,dialectOptions:{socketPath:cfg.socket},logging:false,pool:{min:0,max:2}});
const models={sequelize,Sequelize:S,JobRequest:require(cfg.source+'/models/jobrequest')(sequelize,S.DataTypes)};
const m=require.resolve(cfg.source+'/models');require.cache[m]={id:m,filename:m,loaded:true,exports:models};
const service=require(cfg.source+'/src/services/jobRequests.service');fs.writeFileSync('ready.json',JSON.stringify({pid:process.pid}));
let started=false;setInterval(async()=>{if(started||!cfg.claim||!fs.existsSync('claim-now'))return;started=true;
 fs.writeFileSync('claim-started.json',JSON.stringify({pid:process.pid}));
 try{for(;;){const job=await service.claimNextJob(['normal'],['security_cut_fixture']);if(!job)break;await service.markCompleted(job.id,{resultSummary:{fictitious:true}});}fs.writeFileSync('claims-complete.json',JSON.stringify({pid:process.pid}));}
 catch(e){fs.writeFileSync('claim-failed.json',JSON.stringify({pid:process.pid,code:e.code||e.original?.code||'unexpected'}));process.exitCode=1;}
},20);
`);
    await pm2(['start','/usr/bin/npm','--interpreter','none','--name',id,'--','start'],root);records[id]=await waitState(id,'running');
    await until(()=>fs.existsSync(path.join(root,'ready.json')));assert.notEqual(records[id].pid,records[id].identity.application.pid);
   }
   const participants=Object.entries(records).map(([id,r])=>({id,role:'api',originalPid:r.pid,originalIdentity:r.identity}));participants.push({id:aux.id,role:'auxiliary',originalPid:aux.pid});
   const result=await runClinicalSchemaCut({participants,queues:gates,token,inspect,journal:e=>events.push(e),
    assertQuiet:async context=>{const result=await database(context);if(context.admissionClosed){assert(sqlHeld);expectedPending=result.pendingJobs;assert.equal(expectedPending.count,5);assert.equal(result.counts.jobs,0);assert.equal(result.counts.dueStaging,5);}},
    stop:async id=>{
     processActions.push('stop:'+id);
     if(id===aux.id){aux.state='stopped';aux.pid=0;
      await withQuery(async query=>{for(let id=1;id<=5;id++)await query("INSERT INTO JobRequests(id,type,status,priority,attempts,max_attempts,payload,created_at,updated_at) VALUES(?,'security_cut_fixture','pending','normal',0,5,JSON_OBJECT('__runtime_namespace','staging'),NOW(),NOW())",[id]);});
      await queueObjects[0].add('owned-pending',{}, {jobId:'owned-pending'});return;}
     assert(sqlHeld);assert.equal(providerCalls,0);await pm2(['stop',id]);await waitState(id,'stopped');
    },
    start:async id=>{processActions.push('start:'+id);if(id===aux.id){aux.state='running';aux.pid=10002;return;}
     assert(!sqlHeld);await pm2(['restart',id]);await waitState(id,'running');},
    verifyParticipant:async id=>{assert.equal((await inspect(id)).state,'running');},
    acquireSqlGate:async()=>{
     const gate=await acquireClinicalJobRequestCutGate({connect,database:report.database});sqlHeld=true;
     fs.writeFileSync(path.join(roots['owned-api'],'claim-now'),'');await until(()=>fs.existsSync(path.join(roots['owned-api'],'claim-started.json')));
     await delay(75);await gate.verify();assert(!fs.existsSync(path.join(roots['owned-api'],'claims-complete.json')));
     return{...gate,release:async()=>{await gate.release();sqlHeld=false;}};
    },
    assertStopped:async()=>{for(const id of Object.keys(roots))assert.equal((await inspect(id)).state,'stopped');assert.equal(aux.state,'stopped');if(!sqlHeld)await database({stopped:true,admissionClosed:true,expectedPending});},
    backup:async()=>{
     const dump=spawn('/usr/bin/mysqldump',['--no-defaults','--protocol=SOCKET','--socket='+socket,'--user=root','--single-transaction','--skip-lock-tables','--no-tablespaces','--set-gtid-purged=OFF','--hex-blob',report.database,...meta.TABLES],{stdio:['ignore','pipe','ignore']});
     const done=new Promise(resolve=>dump.once('exit',(code,signal)=>resolve({code,signal}))),file=path.join(report.root,'bound-backup.enc'),key=crypto.randomBytes(32);
     const receipt=await encryptStream(dump.stdout,file,key,crypto.randomBytes(12));assert.deepEqual(await done,{code:0,signal:null});await verifyCipher(file,key,receipt);backupReceipt={file,key,receipt};
    },
    apply:()=>withQuery((query,connection)=>meta.apply({connection,plan,info,database:report.database,
     verifyWritersStopped:async()=>{for(const id of Object.keys(roots))assert.equal((await inspect(id)).state,'stopped');},
     verifyBackup:async()=>{assert(backupReceipt);await verifyCipher(backupReceipt.file,backupReceipt.key,backupReceipt.receipt);},
     loadMigration:m=>require(path.join(source,'migrations',m.name)),journal:e=>events.push(e)})),
    verifyApplied:async value=>{assert.equal(value.completed.length,9);assert.equal(providerCalls,0);
     await withQuery(async query=>{assert.deepEqual(await meta.rowFingerprints(query,plan.columns),plan.rows);assert.deepEqual(await pendingJobFingerprint(query,plan.before.columns.filter(c=>c.TABLE_NAME==='JobRequests').map(c=>c.COLUMN_NAME)),expectedPending);});},
   });
   assert.equal(result.result.completed.length,9);for(let i=0;i<queueObjects.length;i++)assert.equal(await queueObjects[i].isPaused(),oldPauses[i]);
   await until(()=>providerCalls===1);
   await until(async()=>{try{return JSON.parse(fs.readFileSync(path.join(roots['owned-api'],'claims-complete.json'))).pid===(await inspect('owned-api')).identity.application.pid;}catch{return false;}});
   const rows=await withQuery(query=>query('SELECT id,status,attempts FROM JobRequests ORDER BY id'));assert.equal(rows.length,5);assert(rows.every(r=>r.status==='completed'&&r.attempts===1));
   assert.equal(events.at(-1).phase,'cut_complete');assert.deepEqual(processActions,['stop:owned-auxiliary','stop:owned-api','stop:owned-gateway','start:owned-api','start:owned-gateway','start:owned-auxiliary']);
   report.checks.push('Real PM2/npm/Node application runs actual claimNextJob: five jobs due during auxiliary stop stay unclaimed, blocked consumer exits, full pending rows survive encrypted backup and nine DDL, restart completes each exactly once; Redis holds new work until owned restore, all seven earlier pauses preserved');
   report.boundCut={migrations:9,pendingJobsPreserved:5,attemptsAfterRestart:1,priorPauses:7,ownedPausesRestored:5,realPm2:true,auxiliaryManager:'fixture',provider:'fictitious',redisPid:redisChild.pid};
  }finally{
   await pm2(['kill']);if(worker)await worker.close();for(const q of queueObjects)await q.close();if(redis)redis.disconnect();
   if(redisChild){redisChild.kill('SIGTERM');assert.deepEqual(await redisExited,{code:0,signal:null});}
  }
 });
});
