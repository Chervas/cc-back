'use strict';
// Dedicated first-identity process only. It does not load any existing cohort.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {DatabaseSync}=require('node:sqlite');
const {createHash,createPublicKey,randomUUID}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {fail,BrokerError}=require('./errors'),{canonical}=require('./canonical');
const {validatePolicy}=require('./policy'),{BrokerStore}=require('./store'),{Broker}=require('./broker');
const {createServer}=require('./server'),{drainAudit}=require('./audit'),tlsReload=require('./tls-reload');
const {connectAws,ACCOUNT,SECRET_KEY}=require('./google-main');
const {createGoogleHttp}=require('./google-http'),{createGoogleOAuthSecrets}=require('./google-oauth-secrets');
const {createFirstGoogleJournal,TABLE}=require('./google-first-identity-journal');
const {createFirstGoogleProvider}=require('./google-first-identity-provider');
const {createFirstGoogleCredentialVault}=require('./google-first-identity-vault');
const {createFirstGoogleIdentityOwner}=require('./google-first-identity-owner');
const {createFirstGoogleAdmissionRpc,OPERATIONS}=require('./google-first-admission-rpc');
const COHORT='google-first-oauth-v1',PURPOSE='google-first-identity-only-v1',MARKER='google_first_runtime_identity_v1';
const MAX_CONNECTIONS=8,MAX_ACTIVE=2,MAX_PER_MINUTE=12;
const STARTUP_CONCURRENCY=2,STARTUP_TIMEOUT_MS=30000;
const READERS=Object.freeze({
 search_console:Object.freeze({principal:'searchConsoleReaderPrincipal',cursor:'searchConsoleCursorKeyFile',role:'sc',contract:require('./google-search-console-contract')}),
 analytics:Object.freeze({principal:'analyticsReaderPrincipal',cursor:'analyticsCursorKeyFile',role:'ga4',contract:require('./google-analytics-contract')}),
});
const configuredReaders=config=>Object.entries(READERS).filter(([,r])=>Object.hasOwn(config,r.principal)||Object.hasOwn(config,r.cursor));

const hash=v=>createHash('sha256').update(v).digest('hex');
const exact=(o,keys)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join(',')===keys.split(',').sort().join(',');
function privateFile(filename,limit=262144,read=true){
 if(typeof filename!=='string'||!path.isAbsolute(filename)||fs.realpathSync(filename)!==filename)fail('invalid_request');
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd);if(!s.isFile()||s.mode&0o077||s.nlink!==1||![0,process.geteuid()].includes(s.uid)||s.size>limit)fail('invalid_request');return read?fs.readFileSync(fd):s;}
 finally{fs.closeSync(fd);}
}
function privateDirectory(dir){
 if(!path.isAbsolute(dir)||fs.realpathSync(dir)!==dir)fail('invalid_request');const s=fs.lstatSync(dir);
 if(!s.isDirectory()||s.isSymbolicLink()||s.mode&0o077||![0,process.geteuid()].includes(s.uid))fail('invalid_request');
}
const secretPrefix=environment=>'/clinicaclick/integrations/'+(environment==='dev'?'dev':'prod')+'/';
function validateConfig(config){
 const publication=Object.hasOwn(config||{},'publicationResources');
 const readers=configuredReaders(config||{});
 const extra=(publication?',publicationResources':'')+readers.map(([,reader])=>','+reader.principal+','+reader.cursor).join('');
 if(!exact(config,'cohort,purpose,enabled,environment,listenAddress,port,stateFile,tlsCertFile,tlsKeyFile,tlsRenewal,policy,scopes,slots,redirectUri'+extra)
  ||config.cohort!==COHORT||config.purpose!==PURPOSE||config.enabled!==true||!['dev','staging'].includes(config.environment)
  ||!net.isIP(config.listenAddress)||!Number.isInteger(config.port)||config.port<1024||config.port>65535
  ||typeof config.stateFile!=='string'||!path.isAbsolute(config.stateFile)||path.normalize(config.stateFile)!==config.stateFile)fail('invalid_request');
 // Never bind this new control surface to a wildcard or public interface.
 const address=config.listenAddress;
 if(!(address==='::1'||/^127\./.test(address)||/^10\./.test(address)||/^192\.168\./.test(address)||/^172\.(1[6-9]|2[0-9]|3[01])\./.test(address)))fail('invalid_request');
 tlsReload.validateSettings(config.tlsRenewal);const policy=validatePolicy(config.policy),principalId='crm:'+config.environment+':google-first-oauth';
 if(policy.audience!=='clinicaclick:google-first-oauth:'+config.environment+':v1'||policy.version!=='google-first-oauth:'+config.environment+':v1'
  ||policy.maxBacklog>1000||policy.principals.length!==1||policy.principals[0].id!==principalId
  ||policy.principals[0].maxPerMinute>MAX_PER_MINUTE||policy.connections.length||policy.grants.length
  ||!Array.isArray(config.scopes)||!config.scopes.length||config.scopes.length>64||!Array.isArray(config.slots))fail('invalid_request');
 const noop={begin(){},status(){},finish(){},abort(){}};
 createFirstGoogleAdmissionRpc({policy,principalId,scopes:config.scopes,flow:noop,
  ...(publication?{publication:{resources:config.publicationResources,publish(){}}}:{})});
 for(const [service,reader] of readers){
  if(!publication||!config.publicationResources.some(entry=>entry.service===service)
   ||typeof config[reader.cursor]!=='string'||!path.isAbsolute(config[reader.cursor]))fail('invalid_request');
  readerPolicy(config,reader);
 }
 const readerFiles=readers.map(([,reader])=>config[reader.cursor]);
 const readerKeys=readers.map(([,reader])=>readerFingerprint(config[reader.principal]));
 if(new Set(readerFiles).size!==readerFiles.length||new Set(readerKeys).size!==readerKeys.length)fail('invalid_request');

 createFirstGoogleCredentialVault({client:{send(){fail('operation_denied');}},accountId:ACCOUNT,prefix:secretPrefix(config.environment),kmsKeyArn:SECRET_KEY,
  redirectUri:config.redirectUri,slots:config.slots});
 const wanted=config.scopes.flatMap(row=>row.services.map(service=>row.scopeKey+'/'+service)).sort();
 const actual=config.slots.map(row=>row.scopeKey+'/'+row.service).sort();
 if(JSON.stringify(actual)!==JSON.stringify(wanted))fail('invalid_request');
 return config;
}
const readerFingerprint=principal=>createPublicKey(principal.publicKey).export({type:'spki',format:'der'}).toString('hex');
function readerPolicy(config,reader){
 const principal=config[reader.principal];
 if(!principal||principal.enabled!==true||principal.id!=='crm:'+config.environment+':google-first-'+reader.role+'-reader'
  ||principal.maxPerMinute>60)fail('invalid_request');
 const policy=validatePolicy({...config.policy,principals:[...config.policy.principals,principal]});
 const fingerprints=policy.principals.map(readerFingerprint);
 if(new Set(fingerprints).size!==policy.principals.length)fail('invalid_request');
 return policy;
}
function authorityDigest(config){return hash(canonical({cohort:config.cohort,purpose:config.purpose,environment:config.environment,
 policy:config.policy,scopes:config.scopes,slots:config.slots,redirectUri:config.redirectUri,
 ...(Object.hasOwn(config,'publicationResources')?{publicationResources:config.publicationResources}:{}),
 ...Object.fromEntries(configuredReaders(config).flatMap(([,reader])=>[
  [reader.principal,config[reader.principal]],[reader.cursor,config[reader.cursor]],
 ]))}));}
function acquireLock(stateFile){
 privateDirectory(path.dirname(stateFile));const filename=stateFile+'.owner.lock';
 const body=JSON.stringify({purpose:PURPOSE,pid:process.pid,uid:process.geteuid(),nonce:randomUUID()});
 const executable='/usr/bin/flock',binary=fs.lstatSync(executable);
 if(!binary.isFile()||binary.isSymbolicLink()||binary.uid!==0||binary.mode&0o022||fs.realpathSync(executable)!==executable)fail('invalid_request');
 const fd=fs.openSync(filename,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_NOFOLLOW,0o600);
 try{
  const stat=fs.fstatSync(fd),linked=fs.lstatSync(filename);
  if(!stat.isFile()||stat.mode&0o077||stat.nlink!==1||![0,process.geteuid()].includes(stat.uid)
   ||stat.dev!==linked.dev||stat.ino!==linked.ino||fs.realpathSync(filename)!==filename)fail('invalid_request');
  // flock on inherited fd3 locks the same open-file-description retained here.
  // Kernel releases it when Node exits, including SIGKILL; file is never unlinked.
  const result=spawnSync(executable,['-n','-x','3'],{stdio:['ignore','ignore','ignore',fd],env:{PATH:'/usr/bin:/bin',LANG:'C'},timeout:2000});
  if(result.error||result.signal||result.status!==0)fail('oauth_flow_busy');
  fs.ftruncateSync(fd,0);fs.writeFileSync(fd,body);fs.fsyncSync(fd);
  let released=false;return()=>{if(released)return;released=true;fs.closeSync(fd);};
 }catch(error){fs.closeSync(fd);throw error;}
}
function preflightState(filename,digest){
 if(!fs.existsSync(filename))return;
 if(privateFile(filename,1024*1024*1024,false).size===0)return;
 for(const suffix of ['-wal','-shm'])if(fs.existsSync(filename+suffix))privateFile(filename+suffix,1024*1024*1024,false);
 const db=new DatabaseSync(filename,{readOnly:true});
 try{const row=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name=?").get(MARKER);
  if(!row)fail('scope_denied');const rows=db.prepare('SELECT * FROM '+MARKER).all();
  if(rows.length!==1||rows[0].purpose!==PURPOSE||rows[0].authority_digest!==digest)fail('scope_denied');
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')fail('invalid_request');
 }finally{db.close();}
}
function initializeMarker(store,digest){store.transaction(()=>{
 store.db.exec(`CREATE TABLE IF NOT EXISTS ${MARKER}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),purpose TEXT NOT NULL,authority_digest TEXT NOT NULL) STRICT`);
 const rows=store.db.prepare('SELECT * FROM '+MARKER).all();
 if(!rows.length)store.db.prepare('INSERT INTO '+MARKER+' VALUES(1,?,?)').run(PURPOSE,digest);
 else if(rows.length!==1||rows[0].purpose!==PURPOSE||rows[0].authority_digest!==digest)fail('scope_denied');
});}
function transitionAudit(store,config,now,publication=false){return({attemptId,state,reason})=>{
 if(store.backlog().pending>=config.policy.maxBacklog)fail('audit_unavailable');
 const row=store.db.prepare('SELECT principal,tenant,connection,asset FROM '+TABLE+' WHERE id=?').get(attemptId);if(!row)fail('audit_unavailable');
 const action=publication?'publication':reason==='prepared'?'begin':reason==='abort_requested'||reason==='abort_tombstone'?'abort'
  :['owner_exchange_interrupted','attempt_expired','unused_reservation_expired'].includes(reason)?'status':'finish';
 const terminal=['interrupted','aborted','expired','cancelled'].includes(state);
 store.appendAudit({version:2,eventId:randomUUID(),occurredAt:new Date(now()).toISOString(),actorType:'service',actorId:row.principal,
  tenantRef:row.tenant,connectionRef:row.connection,resourceRef:row.asset,correlationId:attemptId,policyVersion:config.policy.version,
  operation:OPERATIONS[action],action:terminal?'integration.failed':'integration.completed',result:terminal?'unknown':'success',reason:'google_first_'+reason});
};}
function restorePlan(config,row){
 const proof={attemptId:row.id,bindingDigest:row.binding_digest,service:row.service,expiresAt:row.expires_at};
 const intent=JSON.parse(row.stage_intent),metadata=JSON.parse(row.metadata),prefix='google-oauth:'+row.service+':';
 return{...proof,scopeKey:row.asset.slice(prefix.length),slotDigest:intent.slotDigest,applicationVersion:row.application_version,
  version:intent.versionId,secretDigest:intent.digest,googleUserId:metadata.googleUserId,clientId:metadata.clientId,
  refreshTokenExpiresAt:metadata.refreshTokenExpiresAt,baselineVersion:intent.baselineVersion,metadataDigest:intent.metadataDigest};
}
async function probeStartupSlots({config,store,secrets,vault,signal}){
 const controller=new AbortController(),guard=AbortSignal.any([signal,controller.signal]),uses=new Map(),apps=new Map();
 let error;
 for(const slot of config.slots)uses.set(slot.clientSecretArn,(uses.get(slot.clientSecretArn)||0)+1);
 const publicApp=async slot=>{
  const app=await secrets.application(slot,guard);
  // Never retain the application secret/object in the startup cache.
  return Object.freeze({clientId:app.clientId,secretVersion:app.secretVersion});
 };
 const application=slot=>{
  if(uses.get(slot.clientSecretArn)===1)return publicApp(slot);
  if(!apps.has(slot.clientSecretArn))apps.set(slot.clientSecretArn,publicApp(slot));
  return apps.get(slot.clientSecretArn);
 };
 async function bounded(values,work){
  let cursor=0;
  async function worker(){
   while(!error&&!guard.aborted&&cursor<values.length){
    const value=values[cursor++];
    try{await work(value);}catch(caught){if(!error)error=caught;controller.abort();}
   }
  }
  await Promise.all(Array.from({length:Math.min(STARTUP_CONCURRENCY,values.length)},worker));
  if(error)throw error;if(guard.aborted)fail('secret_unavailable');
 }
 try{
  await bounded(config.slots,async slot=>{
   const binding={...slot,connectionRef:'google-first:'+slot.service+':'+slot.scopeKey};
   const app=await application(binding);if(guard.aborted)fail('secret_unavailable');
   try{await secrets.assertFirstSlot(binding,slot,guard);}
   catch(error){
    if(guard.aborted)throw error;
    if(!(error instanceof BrokerError)||!['secret_version_changed','secret_unavailable'].includes(error.code))throw error;
    const rows=store.db.prepare('SELECT * FROM '+TABLE+' WHERE asset=? AND stage_intent IS NOT NULL LIMIT 2').all('google-oauth:'+slot.service+':'+slot.scopeKey);
    if(rows.length!==1)throw error;const plan=restorePlan(config,rows[0]);
    if(app.secretVersion!==plan.applicationVersion||app.clientId!==plan.clientId)fail('secret_version_changed');
    await vault.confirmActivation(plan,{signal:guard});
   }
  });
  // A shared application could rotate during the sweep: detect it before
  // listening, interrupting journal contexts or starting the audit drainer.
  await bounded(config.slots.filter((slot,index,all)=>uses.get(slot.clientSecretArn)>1&&all.findIndex(v=>v.clientSecretArn===slot.clientSecretArn)===index),async slot=>{
   const old=await apps.get(slot.clientSecretArn),current=await publicApp(slot);
   if(old.secretVersion!==current.secretVersion||old.clientId!==current.clientId)fail('secret_version_changed');
  });
 }finally{controller.abort();apps.clear();}
}
async function main(filename,{awsFactory=connectAws,http,now=Date.now,report=()=>{}}={}){
 const config=validateConfig(JSON.parse(privateFile(filename)));const cert=privateFile(config.tlsCertFile,65536),key=privateFile(config.tlsKeyFile,65536);
 privateFile(config.tlsRenewal.issuerCaFile,65536);
 const releaseLock=acquireLock(config.stateFile);
 let store,aws,owner,server,maintenance,timer,draining,closing,broker,active=0;
 const readOwners=new Map(),cursorKeys=[],readOperations=new Map();
 for(const [service,{contract}] of configuredReaders(config)){
  for(const operation of [...contract.OPERATIONS,contract.REVOKE_OPERATION])readOperations.set(operation,service);
  if(service==='analytics')readOperations.set(require('./google-property-discovery-contract').GA_ADMISSION_PROOF,service);
 }
 const close=()=>closing||=(async()=>{
  clearInterval(timer);maintenance?.close();owner?.close();
  if(server?.listening)await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();});
  await draining;
  for(const reader of readOwners.values())reader.close();
  for(const cursorKey of cursorKeys)cursorKey.fill(0);
  aws?.close();store?.close();key.fill(0);releaseLock();
 })();
 try{
  server=createServer({async execute(raw,headers){
   if(active>=MAX_ACTIVE)fail('rate_limited');
   active++;
   try{
    // The parsed operation selects a verifier. Each Broker authenticates
    // the unmodified, signed request independently.
    let operation;
    try{operation=JSON.parse(raw).operation;}catch{}
    const target=readOwners.get(readOperations.get(operation))?.broker||broker;
    return await target.execute(raw,headers);
   }finally{active--;}
  }},{cert,key});
  server.maxConnections=MAX_CONNECTIONS;
  // Validate the actual server key/leaf/issuer before opening state or AWS.
  maintenance=tlsReload.install(server,config,{cert,key},{report});
  const digest=authorityDigest(config);preflightState(config.stateFile,digest);store=new BrokerStore(config.stateFile);initializeMarker(store,digest);
  const journal=createFirstGoogleJournal({store,now,onTransition:transitionAudit(store,config,now)});
  aws=await awsFactory();if(!aws?.secrets?.send||!aws?.sink?.write||typeof aws.close!=='function')fail('invalid_request');
  const options={client:aws.secrets,accountId:ACCOUNT,prefix:secretPrefix(config.environment),kmsKeyArn:SECRET_KEY};
  const vault=createFirstGoogleCredentialVault({...options,redirectUri:config.redirectUri,slots:config.slots,now});
  const secrets=createGoogleOAuthSecrets(options),startupSignal=AbortSignal.timeout(STARTUP_TIMEOUT_MS);
  // Read-only startup checks; initialized slots remain anchored to their durable
  // exact intent. Actual first begin still requires the original empty marker.
  await probeStartupSlots({config,store,secrets,vault,signal:startupSignal});
  for(const row of store.db.prepare("SELECT * FROM "+TABLE+" WHERE state IN ('prepared','exchanging','candidate_ready')").all()){
   journal.interrupt({attemptId:row.id,bindingDigest:row.binding_digest,service:row.service,expiresAt:row.expires_at},
    {principalId:row.principal,tenantRef:row.tenant,connectionRef:row.connection,assetRef:row.asset});
  }
  const providerHttp=http||createGoogleHttp();
  const provider=createFirstGoogleProvider({http:providerHttp,now});
  owner=createFirstGoogleIdentityOwner({journal,provider,vault,now});
  let publication;
  if(config.publicationResources){
   const {createFirstGooglePublicationJournal}=require('./google-first-publication-journal');
   const {createFirstGooglePropertyVerifier}=require('./google-first-property-verifier');
   const {createFirstGooglePublicationOwner}=require('./google-first-publication-owner');
   const ledger=createFirstGooglePublicationJournal({store,journal,approvedScopes:config.scopes,now,
    onTransition:transitionAudit(store,config,now,true)});
   const verifier=createFirstGooglePropertyVerifier({vault,ledger,http:providerHttp,now});
   const readerConfigs=configuredReaders(config);
   let recovery;
   if(readerConfigs.some(([service])=>service==='analytics')){
    const {createFirstAnalyticsRecovery}=require('./google-first-analytics-recovery');
    const analyticsSlots=new Map(config.slots.filter(slot=>slot.service==='analytics').map(slot=>[slot.scopeKey,slot]));
    recovery=createFirstAnalyticsRecovery({store,ledger,journal,policyVersion:config.policy.version,maxBacklog:config.policy.maxBacklog,now,
     assertReaderCertificate(value){
      const reader=readOwners.get('analytics');if(!reader)fail('scope_denied');reader.assertCertificate(value);
     },
     async reobserveCurrent(plan,{signal}={}){
      const slot=analyticsSlots.get(plan.scopeKey);
      if(!slot||plan.service!=='analytics')fail('scope_denied');
      const observed=await vault.confirmActivation(plan,{signal});
      if(observed.version!==plan.version||observed.secretDigest!==plan.secretDigest)fail('secret_version_changed');
      const app=await secrets.application(slot,signal);
      if(app.secretVersion!==plan.applicationVersion||app.clientId!==plan.clientId)fail('secret_version_changed');
     }});
   }
   for(const [service,reader] of readerConfigs){
    const {createFirstPropertyReadOwner}=require('./google-first-property-read-owner');
    const {cursorCodec}=require('./provider-cursor');
    const cursorKey=privateFile(config[reader.cursor],32);
    if(cursorKey.length!==32||cursorKeys.some(key=>key.equals(cursorKey))){cursorKey.fill(0);fail('invalid_request');}
    cursorKeys.push(cursorKey);
    readOwners.set(service,createFirstPropertyReadOwner(service,{store,ledger,firstJournal:journal,vault,client:aws.secrets,http:providerHttp,
     cursor:cursorCodec(cursorKey),policy:readerPolicy(config,reader),readerPrincipalId:config[reader.principal].id,
     controlPrincipalId:config.policy.principals[0].id,approvedScopes:config.scopes,slots:config.slots,redirectUri:config.redirectUri,
     accountId:ACCOUNT,prefix:secretPrefix(config.environment),kmsKeyArn:SECRET_KEY,now,
     ...(service==='analytics'?{readAllowed:recovery.readAllowed}:{})}));
   }
   const publisher=createFirstGooglePublicationOwner({ledger,vault,verifier,now});
   // Existing configurations without an Analytics reader retain OAuth state
   // handling. Offering or confirming a GA property needs the native reader.
   const resources=config.publicationResources.filter(row=>row.service!=='analytics'||readOwners.has('analytics'));
   const assertSelectedActive=(proof,selection)=>store.assertAssetActive({
    tenantRef:'clinic:'+selection.clinicId,connectionRef:'google-first:'+proof.service+':'+selection.scopeKey,assetRef:selection.assetRef,
   });
   function analyticsSubject(proof,owner){
    const {state}=journal.read(proof,owner),record=journal.getPrivateState(proof,owner);
    if(proof.service!=='analytics'||state!=='candidate_staged'||record.cancelRequested||!record.metadata||!record.stageIntent
      ||hash(canonical(record.metadata))!==record.metadataDigest)fail('scope_denied');
    return record.metadata.googleUserId;
   }
   if(resources.length)publication={
    resources,
    ...(recovery?{identityPreview:analyticsSubject,recovery}:{}),
    async publish(proof,owner,selection,resource,options){
     assertSelectedActive(proof,selection);
     if(proof.service==='analytics'){
      const {firstAnalyticsSubjectDigest}=require('./google-property-discovery-contract');
      if(firstAnalyticsSubjectDigest(analyticsSubject(proof,owner))!==options.expectedSubjectDigest)fail('oauth_identity_mismatch');
      recovery.begin(options.pins);
     }
     const receipt=await publisher.publish(proof,owner,selection,resource,options);
     assertSelectedActive(proof,selection);
     await readOwners.get(proof.service)?.bootstrap({proof,owner,receipt});
     if(proof.service==='analytics')recovery.assertOpen(options.pins);
     return receipt;
    },
    async observe(proof,owner,selection,resource,options){
     assertSelectedActive(proof,selection);
     const observation=await verifier.observe(proof,owner,selection,resource,options);
     assertSelectedActive(proof,selection);
     return observation;
    },
   };
  }
  const rpc=createFirstGoogleAdmissionRpc({policy:config.policy,principalId:config.policy.principals[0].id,scopes:config.scopes,flow:owner,publication,now});
  broker=new Broker({store,policy:config.policy,...rpc,now,secrets:{withSecret(){fail('operation_denied');}}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.listenAddress,()=>{server.removeListener('error',reject);resolve();});});
  const tick=()=>{if(!draining)draining=drainAudit(store,aws.sink,{limit:20,now}).catch(()=>null).finally(()=>{draining=null;});};
  tick();timer=setInterval(tick,1000);timer.unref();
  return Object.freeze({server,store,broker,close});
 }catch(error){await close();throw error;}
}
if(require.main===module)main(process.argv[2]).then(runtime=>{
 const stop=()=>runtime.close().catch(()=>{process.exitCode=1;});process.once('SIGTERM',stop);process.once('SIGINT',stop);
}).catch(()=>{process.stderr.write('GOOGLE_FIRST_OWNER_START_FAILED\n');process.exitCode=1;});
module.exports={main,validateConfig,COHORT,PURPOSE,MAX_CONNECTIONS,MAX_ACTIVE,MAX_PER_MINUTE,STARTUP_CONCURRENCY,STARTUP_TIMEOUT_MS,
 scopeAdditionMaintenance:Object.freeze({authorityDigest,acquireLock,preflightState,privateFile,privateDirectory,MARKER,PURPOSE}),probeStartupSlots};
