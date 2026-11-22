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
 const reader=Object.hasOwn(config||{},'searchConsoleReaderPrincipal')||Object.hasOwn(config||{},'searchConsoleCursorKeyFile');
 const extra=(publication?',publicationResources':'')+(reader?',searchConsoleReaderPrincipal,searchConsoleCursorKeyFile':'');
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
 if(reader){
  if(!publication||!config.publicationResources.some(entry=>entry.service==='search_console')
   ||typeof config.searchConsoleCursorKeyFile!=='string'||!path.isAbsolute(config.searchConsoleCursorKeyFile))fail('invalid_request');
  readerPolicy(config);
 }
 createFirstGoogleCredentialVault({client:{send(){fail('operation_denied');}},accountId:ACCOUNT,prefix:secretPrefix(config.environment),kmsKeyArn:SECRET_KEY,
  redirectUri:config.redirectUri,slots:config.slots});
 const wanted=config.scopes.flatMap(row=>row.services.map(service=>row.scopeKey+'/'+service)).sort();
 const actual=config.slots.map(row=>row.scopeKey+'/'+row.service).sort();
 if(JSON.stringify(actual)!==JSON.stringify(wanted))fail('invalid_request');
 return config;
}
function readerPolicy(config){
 const principal=config.searchConsoleReaderPrincipal;
 if(!principal||principal.enabled!==true||principal.id!=='crm:'+config.environment+':google-first-sc-reader'
  ||principal.maxPerMinute>60)fail('invalid_request');
 const policy=validatePolicy({...config.policy,principals:[...config.policy.principals,principal]});
 const fingerprints=policy.principals.map(row=>createPublicKey(row.publicKey).export({type:'spki',format:'der'}).toString('hex'));
 if(new Set(fingerprints).size!==policy.principals.length)fail('invalid_request');
 return policy;
}
function authorityDigest(config){return hash(canonical({cohort:config.cohort,purpose:config.purpose,environment:config.environment,
 policy:config.policy,scopes:config.scopes,slots:config.slots,redirectUri:config.redirectUri,
 ...(Object.hasOwn(config,'publicationResources')?{publicationResources:config.publicationResources}:{}),
 ...(Object.hasOwn(config,'searchConsoleReaderPrincipal')?{searchConsoleReaderPrincipal:config.searchConsoleReaderPrincipal,
  searchConsoleCursorKeyFile:config.searchConsoleCursorKeyFile}:{})}));}
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
async function main(filename,{awsFactory=connectAws,http,now=Date.now,report=()=>{}}={}){
 const config=validateConfig(JSON.parse(privateFile(filename)));const cert=privateFile(config.tlsCertFile,65536),key=privateFile(config.tlsKeyFile,65536);
 privateFile(config.tlsRenewal.issuerCaFile,65536);
 const releaseLock=acquireLock(config.stateFile);
 let store,aws,owner,server,maintenance,timer,draining,closing,broker,readOwner,cursorKey,active=0;
 const readOperations=config.searchConsoleReaderPrincipal ? new Set([
  ...require('./google-search-console-contract').OPERATIONS,require('./google-search-console-contract').REVOKE_OPERATION,
 ]) : null;
 const close=()=>closing||=(async()=>{
  clearInterval(timer);maintenance?.close();owner?.close();
  if(server?.listening)await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();});
  await draining;readOwner?.close();cursorKey?.fill(0);aws?.close();store?.close();key.fill(0);releaseLock();
 })();
 try{
  server=createServer({async execute(raw,headers){
   if(active>=MAX_ACTIVE)fail('rate_limited');
   active++;
   try{
    let target=broker;
    if(readOwner){
     // The parsed operation only selects the verifier. Authentication and
     // authority still cover the original signed request in that Broker.
     let operation;
     try{operation=JSON.parse(raw).operation;}catch{}
     if(readOperations.has(operation))target=readOwner.broker;
    }
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
  const secrets=createGoogleOAuthSecrets(options),startupSignal=AbortSignal.timeout(10000);
  // Read-only startup checks; initialized slots remain anchored to their durable
  // exact intent. Actual first begin still requires the original empty marker.
  for(const slot of config.slots){
   const binding={...slot,connectionRef:'google-first:'+slot.service+':'+slot.scopeKey};
   const application=await secrets.application(binding,startupSignal);
   try{await secrets.assertFirstSlot(binding,slot,startupSignal);}
   catch(error){
    if(!(error instanceof BrokerError)||!['secret_version_changed','secret_unavailable'].includes(error.code))throw error;
    const rows=store.db.prepare('SELECT * FROM '+TABLE+' WHERE asset=? AND stage_intent IS NOT NULL LIMIT 2').all('google-oauth:'+slot.service+':'+slot.scopeKey);
    if(rows.length!==1)throw error;const plan=restorePlan(config,rows[0]);
    if(application.secretVersion!==plan.applicationVersion||application.clientId!==plan.clientId)fail('secret_version_changed');
    await vault.confirmActivation(plan,{signal:startupSignal});
   }
  }
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
   if(config.searchConsoleReaderPrincipal){
    const {createFirstSearchConsoleReadOwner}=require('./google-first-search-console-read-owner');
    const {cursorCodec}=require('./provider-cursor');
    cursorKey=privateFile(config.searchConsoleCursorKeyFile,32);
    if(cursorKey.length!==32)fail('invalid_request');
    readOwner=createFirstSearchConsoleReadOwner({store,ledger,firstJournal:journal,vault,client:aws.secrets,http:providerHttp,
     cursor:cursorCodec(cursorKey),policy:readerPolicy(config),readerPrincipalId:config.searchConsoleReaderPrincipal.id,
     controlPrincipalId:config.policy.principals[0].id,approvedScopes:config.scopes,slots:config.slots,redirectUri:config.redirectUri,
     accountId:ACCOUNT,prefix:secretPrefix(config.environment),kmsKeyArn:SECRET_KEY,now});
   }
   const publisher=createFirstGooglePublicationOwner({ledger,vault,verifier,now});
   publication={
    resources:config.publicationResources,
    async publish(proof,owner,selection,resource,options){
     const receipt=await publisher.publish(proof,owner,selection,resource,options);
     if(proof.service==='search_console'&&readOwner)await readOwner.bootstrap({proof,owner,receipt});
     return receipt;
    },
    observe:verifier.observe,
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
module.exports={main,validateConfig,COHORT,PURPOSE,MAX_CONNECTIONS,MAX_ACTIVE,MAX_PER_MINUTE};
