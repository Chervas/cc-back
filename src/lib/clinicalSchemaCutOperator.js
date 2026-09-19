'use strict';
// Root coordination bound by explicit Meta/Google entry points. Does not publish application
// code, alter configuration, enable providers, or replay historical work.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),http=require('node:http'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {sourceInfo}=require('../scripts/security-schema-release');
const {observedEnvironment}=require('../scripts/security-email-login-metadata');
const schema=require('./securitySchemaContract');
const {clinicalCutDatabaseCheck,historicalSql}=require('./clinicalCutDatabaseCheck');
const {pendingJobFingerprint}=require('./clinicalCutActivity');
const {observePm2Application,processIdentity}=require('./clinicalCutProcessIdentity');
const {systemdProcessObservation}=require('./clinicalCutSystemdIdentity');
const {clinicalCutFailure}=require('./clinicalCutFailure');
const {runClinicalSchemaCut}=require('./clinicalSchemaCutCoordinator');
const {acquireClinicalJobRequestCutGate}=require('./clinicalJobRequestCutGate');
const {clinicalBullmqCutGate}=require('./clinicalBullmqCutGate');
function createClinicalSchemaCutOperator({source,operator,policy,assertRuntime=()=>{}}){
 assert(path.isAbsolute(source)&&typeof operator?.run==='function'&&typeof policy?.validate==='function'&&typeof policy?.rowFingerprints==='function','clinical_cut_binding_required');
const unitNames=['clinicaclick-whatsapp-fresh-inbound.service','clinicaclick-whatsapp-inbox-consumer.service'];
const names=['outbound_whatsapp','webhook_whatsapp','whatsapp_template_create','whatsapp_template_sync','whatsapp_phone_sync','automation_defaults'];
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const command=(bin,args,timeout=45000)=>cp.execFileSync(bin,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout}).trim();
function parse(argv){
 const[action,dirKey,dir,outKey,out,...rest]=argv;
 if(!['preflight','cut'].includes(action)||dirKey!=='--dir'||outKey!=='--out'||rest.length
  ||!dir||path.dirname(dir)!=='/var/lib/clinicaclick-schema-recovery'||!/^[a-z0-9-]{6,100}$/.test(path.basename(dir))
  ||!out||!out.startsWith('/home/ubuntu/qa-evidence/')||path.resolve(out)!==out)throw Error('clinical_cut_arguments_invalid');
 return{action,dir,out};
}
function syncDir(dir){const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function save(out,name,value){const fd=fs.openSync(path.join(out,name),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDir(out);}
function secure(file,directory=false){const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||stat.uid!==0||stat.mode&0o077||(directory?!stat.isDirectory():!stat.isFile()))throw Error('clinical_cut_private_artifact_invalid');}
function valuesForUnit(name){return Object.fromEntries(command('systemctl',['show',name,'--property=MainPID,ActiveState,NRestarts,ExecMainStatus,FragmentPath,DropInPaths,EnvironmentFiles']).split('\n').map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));}
function unitSnapshot(name){
 const v=valuesForUnit(name),files=[v.FragmentPath,...(v.DropInPaths||'').split(' ').filter(Boolean),...(v.EnvironmentFiles||'').split(' ').filter(x=>x.startsWith('/'))];
 const observation=systemdProcessObservation(v);
 return{name,pid:observation.pid,active:v.ActiveState,restarts:Number(v.NRestarts),exit:Number(v.ExecMainStatus),identity:observation.identity,observation,configuration:files.map(file=>({file,sha256:digest(fs.readFileSync(file))}))};
}
const units=()=>unitNames.map(unitSnapshot);
const pm2Rows=()=>JSON.parse(command('sudo',['-n','-u','ubuntu','-H','/usr/bin/pm2','jlist']));
function inspect(id){
 if(id==='pm2-back-staging'||id==='pm2-gateway')return observePm2Application({rows:pm2Rows(),id,root:id==='pm2-back-staging'?'/home/ubuntu/wt/back-staging':'/home/ubuntu/wt/gateway'});
 assert(unitNames.includes(id),'clinical_cut_unknown_participant');return unitSnapshot(id).observation;
}
function environmentDigest(env){return digest(JSON.stringify(Object.fromEntries(Object.entries(env).filter(([k])=>/^(AUTH_|WHATSAPP_|EMAIL_|META_|GOOGLE_|AI_|BEDROCK_|AWS_|JOBS_|JOB_|RUNTIME_|QUEUE_|REDIS_|DB_|CLINICACLICK_|CREDENTIAL_|INTEGRATION_|SECURITY_|PLATFORM_|SYSTEM_|PORT$)/.test(k)).sort(([a],[b])=>a.localeCompare(b)))));}
function runtime(name){
 const r=observedEnvironment(name);assertRuntime(r.env);assert.equal(r.env.AUTH_EMAIL_MFA_MODE,'enforce');assert.equal(r.env.AUTH_SESSION_MODE,'enforce');
 for(const[k,v]of Object.entries(r.env))if(/^META_MARKETING_.*ENABLED$/.test(k))assert(['','false'].includes(v));
 assert.equal(command('git',['-c','safe.directory='+r.root,'-C',r.root,'status','--porcelain']),'');
 const id=name==='staging'?'pm2-back-staging':'pm2-gateway',manager=inspect(id);assert.equal(manager.state,'running');assert.equal(manager.identity.application.pid,r.process.pid);
 return{name,id,root:r.root,pid:r.process.pid,managerPid:manager.pid,identity:manager.identity,revision:command('git',['-c','safe.directory='+r.root,'-C',r.root,'rev-parse','HEAD']),environmentDigest:environmentDigest(r.env),envFileDigest:digest(fs.readFileSync(r.root+'/.env')),queuePrefix:r.env.QUEUE_PREFIX||'bull'};
}
function protectedDev(){
 const result={};for(const name of ['clinicaclick-back-dev.service','clinicaclick-dev-security.service']){
  const v=valuesForUnit(name);assert.equal(v.ActiveState,'active','clinical_cut_dev_not_active');const pid=Number(v.MainPID);result[pid]=processIdentity(pid);
  if(name==='clinicaclick-dev-security.service'){const children=fs.readFileSync('/proc/'+pid+'/task/'+pid+'/children','utf8').trim();assert(children,'clinical_cut_dev_worker_missing');for(const value of children.split(' ').filter(Boolean)){const child=Number(value);result[child]=processIdentity(child);}}
 }return result;
}
async function connect(database){
 secure('/etc/mysql/debian.cnf');const text=fs.readFileSync('/etc/mysql/debian.cnf','utf8').match(/\[client\]([^]*?)(?=\n\[|$)/)?.[1];assert(text);
 const c=require('dotenv').parse(text);assert.equal(c.socket,'/var/run/mysqld/mysqld.sock');assert(c.user&&c.password);
 return require('mysql2/promise').createConnection({socketPath:c.socket,user:c.user,password:c.password,database,connectTimeout:5000});
}
async function ready(port){const deadline=Date.now()+40000;for(;;){const status=await new Promise(resolve=>{const r=http.get('http://127.0.0.1:'+port+'/api/auth/me',res=>{res.resume();resolve(res.statusCode);});r.once('error',()=>resolve(0));r.setTimeout(1000,()=>r.destroy());});if(status===401)return;assert(Date.now()<deadline,'clinical_cut_api_readiness_timeout');await delay(250);}}
async function waitState(id,state){const deadline=Date.now()+60000;for(;;){const current=inspect(id);if(current.state===state&&(state!=='stopped'||current.pid===0))return current;assert(Date.now()<deadline,'clinical_cut_manager_timeout');await delay(200);}}
function noPublicNodes(){
 for(const id of fs.readdirSync('/proc').filter(v=>/^[1-9][0-9]*$/.test(v))){
  let cwd,args;try{cwd=fs.realpathSync('/proc/'+id+'/cwd');args=fs.readFileSync('/proc/'+id+'/cmdline','utf8').split('\0');}catch{continue;}
  if(['/home/ubuntu/wt/back-staging','/home/ubuntu/wt/gateway'].includes(cwd)&&args.some(a=>/(^|\/)(node|npm)$|src\/app\.js/.test(a)))throw Error('clinical_cut_public_process_live');
 }for(const u of units())assert.equal(u.pid,0,'clinical_cut_auxiliary_process_live');
}
async function run(argv){
 assert.equal(process.getuid(),0,'clinical_cut_root_required');const o=parse(argv);
 secure(o.dir,true);secure(o.dir+'/plan.json');const plan=JSON.parse(fs.readFileSync(o.dir+'/plan.json'));
 const info=sourceInfo(source,true);assert.equal(info.revision,plan.revision,'clinical_cut_source_changed');
 assert(!fs.existsSync(o.dir+'/journal.jsonl'),'clinical_cut_existing_ddl_journal');assert(!fs.existsSync(o.dir+'/control-journal.jsonl'),'clinical_cut_existing_control_journal');
 if(!fs.existsSync(o.out))fs.mkdirSync(o.out,{mode:0o700});assert.equal(fs.realpathSync(o.out),o.out);secure(o.out,true);
 const before={at:new Date().toISOString(),runtimes:['staging','gateway'].map(runtime),units:units(),dev:protectedDev()};
 assert.deepEqual(before.runtimes.map(r=>r.pid),plan.target.processes.map(p=>p.pid));assert(before.units.every(u=>u.observation.state==='running'&&u.identity&&u.restarts===0));
 assert.deepEqual(before.runtimes.map(r=>r.queuePrefix),['staging','gateway']);
 const db=()=>connect(plan.database),database=options=>clinicalCutDatabaseCheck({connect:db,plan,info,policy,...options});before.database=await database();
 const api=observedEnvironment('staging').env,gateway=observedEnvironment('gateway').env;assert.equal(api.REDIS_URL,gateway.REDIS_URL);
 const redisUrl=api.REDIS_URL||'redis://127.0.0.1:6379',url=new URL(redisUrl);assert(['localhost','127.0.0.1'].includes(url.hostname));assert(['','6379'].includes(url.port));
 const Redis=require('ioredis'),redis=new Redis(redisUrl,{lazyConnect:true,maxRetriesPerRequest:0,retryStrategy:()=>null,connectTimeout:3000,commandTimeout:5000});redis.on('error',()=>{});
 let journalFd,gateHeld=false,expectedPending;
 const activeQueues=async()=>{for(const r of before.runtimes)for(const name of names)assert.equal(await redis.llen(r.queuePrefix+':'+name+':active'),0,'clinical_cut_active_queue');};
 try{
  await redis.connect();before.queueStates=[];
  for(const r of before.runtimes)for(const name of names){const key=r.queuePrefix+':'+name+':meta';assert.equal(await redis.exists(key),1);before.queueStates.push({prefix:r.queuePrefix,name,paused:await redis.hexists(key,'paused')===1});}
  await activeQueues();
  if(o.action==='preflight'){save(o.out,'preflight.json',before);return{status:'ready',runtimes:before.runtimes.map(r=>({name:r.name,pid:r.pid,managerPid:r.managerPid})),activeWork:before.database.counts,queueStates:before.queueStates};}
  save(o.out,'cut-started.json',before);const token=crypto.randomUUID();save(o.out,'operation.json',{at:new Date().toISOString(),token,revision:info.revision,recovery:o.dir});
  journalFd=fs.openSync(o.dir+'/control-journal.jsonl','wx',0o600);syncDir(o.dir);
  const journal=e=>{fs.writeSync(journalFd,JSON.stringify({at:new Date().toISOString(),...e})+'\n');fs.fsyncSync(journalFd);};
  const participants=[...before.runtimes.map(r=>({id:r.id,role:'api',originalPid:r.managerPid,originalIdentity:r.identity})),...before.units.map(u=>({id:u.name,role:'auxiliary',originalPid:u.pid,originalIdentity:u.identity}))];
  const verifyParticipant=async id=>{
   if(id.startsWith('pm2-')){const name=id==='pm2-back-staging'?'staging':'gateway';await ready(name==='staging'?3001:3000);const prior=before.runtimes.find(r=>r.name===name),now=runtime(name);
    for(const key of ['revision','environmentDigest','envFileDigest','queuePrefix'])assert.equal(now[key],prior[key],'clinical_cut_runtime_configuration_changed');
   }else{const prior=before.units.find(u=>u.name===id),now=units().find(u=>u.name===id);assert.equal(now.active,'active');assert.equal(now.restarts,0);assert.deepEqual(now.configuration,prior.configuration);}
  };
  try{
   const result=await runClinicalSchemaCut({participants,queues:before.queueStates.map(q=>clinicalBullmqCutGate({client:redis,...q,token})),token,journal,inspect:async id=>inspect(id),
    stop:async id=>{const prior=participants.find(p=>p.id===id),now=inspect(id);assert.equal(now.state,'running');assert.equal(now.pid,prior.originalPid);assert.deepEqual(now.identity,prior.originalIdentity,'clinical_cut_identity_changed_before_stop');
     if(id.startsWith('pm2-'))command('sudo',['-n','-u','ubuntu','-H','/usr/bin/pm2','stop',id],10000);else command('systemctl',['stop','--no-block',id]);await waitState(id,'stopped');},
    start:async id=>{if(id.startsWith('pm2-')){command('sudo',['-n','-u','ubuntu','-H','/usr/bin/pm2','restart',id]);await ready(id==='pm2-back-staging'?3001:3000);}else command('systemctl',['start',id]);await waitState(id,'running');},
    verifyParticipant,
    assertQuiet:async context=>{const checked=await database(context);if(context.admissionClosed){assert(gateHeld);expectedPending=checked.pendingJobs;journal({phase:'pending_jobs_held',pendingJobs:expectedPending,counts:checked.counts});}await activeQueues();},
    acquireSqlGate:async()=>{const gate=await acquireClinicalJobRequestCutGate({connect:db,database:plan.database});gateHeld=true;return{...gate,release:async()=>{await gate.release();gateHeld=false;}};},
    assertStopped:async()=>{noPublicNodes();if(!gateHeld){assert(expectedPending);const settled=await database({stopped:true,admissionClosed:true,expectedPending});assert.equal(settled.historicalGatewayDigest,before.database.historicalGatewayDigest,'clinical_cut_history_changed');}},
    backup:async()=>{save(o.out,'backup-verified.json',{at:new Date().toISOString(),...await operator.run(['backup','--source',source,'--dir',o.dir])});},
    apply:()=>operator.run(['apply','--source',source,'--dir',o.dir]),
    verifyApplied:async value=>{const c=await db();try{const q=async(s,v=[])=>(await c.query(s,v))[0],actual=await schema.snapshot(q);
      for(const r of before.runtimes)assert.equal(schema.compare(actual,sourceInfo(r.root,true).contract).compatible,true,'clinical_cut_old_consumer_incompatible');
      assert.deepEqual(await pendingJobFingerprint(q,plan.before.columns.filter(c=>c.TABLE_NAME==='JobRequests').map(c=>c.COLUMN_NAME)),expectedPending,'clinical_cut_pending_jobs_changed');
      assert.equal(schema.digest(await q(historicalSql)),before.database.historicalGatewayDigest,'clinical_cut_history_changed');
      save(o.out,'schema-verified.json',{at:new Date().toISOString(),...value,oldConsumersCompatible:true,pendingJobsPreserved:expectedPending,historicalGatewayJobsUnchanged:true});
     }finally{await c.end();}},
   });
   assert.deepEqual(protectedDev(),before.dev,'clinical_cut_dev_changed');
   for(const q of before.queueStates)assert.equal(await redis.hexists(q.prefix+':'+q.name+':meta','paused')===1,q.paused,'clinical_cut_queue_pause_changed');
   const after={at:new Date().toISOString(),revision:info.revision,migrations:result.result.completed.length,rowsPreserved:result.result.rowsPreserved,runtimes:['staging','gateway'].map(runtime),units:units(),recovered:result.recovered,queueStates:before.queueStates,devProcessesUnchanged:true,sourcePublished:false,uiPublished:false,metaGatesOff:true,integrationGatesUnchanged:true,mfaEnforced:true};
   save(o.out,'cut-complete.json',after);return{status:'clinical_schema_cut_complete',migrations:after.migrations,rowsPreserved:after.rowsPreserved,runtimes:after.runtimes.map(r=>({name:r.name,pid:r.pid,managerPid:r.managerPid}))};
  }catch(error){save(o.out,'cut-failed.json',{at:new Date().toISOString(),failure:clinicalCutFailure(error),recoveryFailures:error.recoveryFailures||[]});throw error;}
 }finally{if(journalFd!==undefined)fs.closeSync(journalFd);redis.disconnect();}
}
return {parse,run};
}
module.exports={createClinicalSchemaCutOperator};
