'use strict';
// A normal read Broker inside the dedicated Owner. No browser bootstrap route.
const {createHash,randomUUID,createPublicKey}=require('node:crypto');
const {canonical}=require('./canonical'),{fail}=require('./errors'),{validatePolicy}=require('./policy'),{Broker}=require('./broker');
const C=require('./google-search-console-contract'),OAuth=require('./google-oauth-contract');
const {requiredScopesFor}=require('./google-first-identity-provider');
const {createSearchConsoleOperations}=require('./google-search-console'),{createGoogleSecretStore}=require('./google-secrets');
const {createGoogleOAuthSecrets}=require('./google-oauth-secrets');
const {createFirstGoogleCredentialVault}=require('./google-first-identity-vault');
const TABLE='google_first_sc_read_authorities_v1',DOMAIN='clinicaclick/google-first-sc-read/1';
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const exact=(o,keys)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Reflect.ownKeys(o).length===keys.split(',').length&&keys.split(',').every(k=>Object.hasOwn(o,k));
const DDL=`CREATE TABLE IF NOT EXISTS ${TABLE}(connection TEXT PRIMARY KEY,tenant TEXT NOT NULL,asset TEXT NOT NULL,attempt_id TEXT NOT NULL UNIQUE,
 body TEXT NOT NULL,body_digest TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT`;
function createFirstSearchConsoleReadOwner({store,ledger,firstJournal,vault,client,http,cursor,policy,readerPrincipalId,controlPrincipalId,
 approvedScopes,slots,redirectUri,accountId,prefix,kmsKeyArn,now=Date.now}={}){
 if(!store?.db||typeof store.transaction!=='function'||!ledger?.getPrivateState||!firstJournal?.read||!firstJournal?.getPrivateState
  ||!vault?.confirmActivation||!client?.send||typeof http!=='function'||!cursor?.seal||!cursor?.open||typeof now!=='function'
  ||!Array.isArray(approvedScopes)||!Array.isArray(slots))fail('invalid_request');
 const base=structuredClone(validatePolicy(policy)),policyDigest=digest(base),cache=new Map(),scopeMap=new Map(),slotMap=new Map();
 if(base.connections.length||base.grants.length||base.principals.length!==2||base.maxBacklog>1000||readerPrincipalId===controlPrincipalId
  ||!base.principals.some(p=>p.id===readerPrincipalId&&p.enabled&&p.maxPerMinute<=60)
  ||!base.principals.some(p=>p.id===controlPrincipalId&&p.enabled&&p.maxPerMinute<=12))fail('invalid_request');
 const keys=base.principals.map(p=>createPublicKey(p.publicKey).export({type:'spki',format:'der'}).toString('hex'));
 if(new Set(keys).size!==2)fail('invalid_request');
 for(const scope of approvedScopes)if(scope.services?.includes('search_console')){
  if(!exact(scope,'scopeKey,clinicIds,services')||!scope.clinicIds?.length||scopeMap.has(scope.scopeKey))fail('invalid_request');scopeMap.set(scope.scopeKey,structuredClone(scope));
 }
 for(const slot of slots)if(slot.service==='search_console'){
  if(!exact(slot,'scopeKey,service,secretArn,clientSecretArn,baselineVersion')||slotMap.has(slot.scopeKey)||!scopeMap.has(slot.scopeKey))fail('invalid_request');slotMap.set(slot.scopeKey,Object.freeze({...slot}));
 }
 if(!slotMap.size||slotMap.size>64||slotMap.size!==scopeMap.size)fail('invalid_request');
 // Validate dedicated slot namespaces, all disjoint destinations and the
 // config-derived slot digest with the existing first vault, not a new parser.
 const configuredVault=createFirstGoogleCredentialVault({client,accountId,prefix,kmsKeyArn,slots,redirectUri,now});
 const secretApi=createGoogleOAuthSecrets({client,accountId,prefix,kmsKeyArn});
 const clock=()=>{const n=now();if(!Number.isSafeInteger(n)||n<=0)fail('invalid_request');return n;};
 store.transaction(()=>{store.db.exec(DDL);const sql=store.db.prepare("SELECT sql FROM sqlite_schema WHERE name=? AND type='table'").get(TABLE)?.sql;
  const norm=s=>s.replace('IF NOT EXISTS ','').replace(/\s+/g,' ').trim();if(!sql||norm(sql)!==norm(DDL))fail('invalid_request');
  const extra=store.db.prepare("SELECT * FROM sqlite_schema WHERE tbl_name=? AND type<>'table'").all(TABLE);
  if(extra.length!==2||extra.some(r=>r.type!=='index'||r.sql!==null||!r.name.startsWith('sqlite_autoindex_'+TABLE+'_')))fail('invalid_request');
 });
 function source(proof,owner,allowClosed=false){
  const state=ledger.getPrivateState(proof,owner),first=firstJournal.read(proof,owner),privateFirst=firstJournal.getPrivateState(proof,owner),r=state.receipt;
  if(proof.service!=='search_console'||!r||r.mode!=='provisioned'||r.status!=='confirmed_resource_access'||!state.activationReadbackDigest
   ||!state.activationIntent||!state.selection||!exact(r.resource,'siteUrl,permissionLevel')||r.secretVersion!==proof.attemptId
   ||r.connectionRef!=='google-first:search_console:'+state.selection.scopeKey||r.clinicId!==state.selection.clinicId||r.assetRef!==state.selection.assetRef)fail('scope_denied');
  const scope=scopeMap.get(r.scopeKey),slot=slotMap.get(r.scopeKey),site=C.site(r.resource.siteUrl);
  if(!scope||!slot||!scope.clinicIds.includes(r.clinicId)||site.assetRef!==r.assetRef||state.activationIntent.vaultPlan.googleUserId!==r.googleUserId
   ||state.activationIntent.vaultPlan.version!==r.secretVersion||state.activationIntent.vaultPlan.baselineVersion!==slot.baselineVersion)fail('scope_denied');
  const live=state.state==='confirmed'&&!state.cancelRequested&&first.state==='candidate_staged'&&!privateFirst.cancelRequested;
  if(!allowClosed&&!live)fail('asset_revoked');
  const body={version:1,proof:{...proof},owner:{...owner},selection:state.selection,receipt:r,sourceCredentialDigest:state.credentialDigest,
   plan:state.activationIntent.vaultPlan,refreshTokenExpiresAt:privateFirst.metadata.refreshTokenExpiresAt,readerPrincipalId,controlPrincipalId,policyVersion:base.version};
  return{body,bodyDigest:digest([DOMAIN,body]),live,slot};
 }
 function certificate(connection,allowClosed=false){
  const row=store.db.prepare('SELECT * FROM '+TABLE+' WHERE connection=?').get(connection);if(!row)fail('scope_denied');
  let saved;try{saved=JSON.parse(row.body);}catch{fail('scope_denied');}
  if(canonical(saved)!==row.body||row.body_digest!==digest([DOMAIN,saved]))fail('scope_denied');
  const current=source(saved.proof,saved.owner,allowClosed),r=current.body.receipt;
  if(current.bodyDigest!==row.body_digest||canonical(current.body)!==row.body||row.connection!==r.connectionRef||row.tenant!=='clinic:'+r.clinicId
   ||row.asset!==r.assetRef||row.attempt_id!==r.attemptId)fail('scope_denied');
  if(!allowClosed&&current.body.refreshTokenExpiresAt!==null&&current.body.refreshTokenExpiresAt<=clock())fail('connection_blocked');
  return{...current,row};
 }
 function active(connection){const cert=certificate(connection);store.connection(connection,clock());
  store.assertAssetActive({tenantRef:cert.row.tenant,connectionRef:connection,assetRef:cert.row.asset});return cert;}
 function binding(cert){const r=cert.body.receipt,plan=cert.body.plan;
  return{connectionRef:r.connectionRef,provider:C.PROVIDER,initialState:'active',expiresAt:cert.body.refreshTokenExpiresAt,
   secretArn:cert.slot.secretArn,clientSecretArn:cert.slot.clientSecretArn,googleSubject:r.googleUserId,
   oauth:{subject:r.googleUserId,redirectUri,scopes:requiredScopesFor('search_console')},searchConsoleSites:[{siteUrl:r.resource.siteUrl,assetRef:r.assetRef}]};
 }
 function resolve(request,principal,livePolicy){
  if(digest(livePolicy)!==policyDigest||!C.OPERATIONS.includes(request.operation)&&request.operation!==C.REVOKE_OPERATION)fail('operation_denied');
  const revoking=request.operation===C.REVOKE_OPERATION,role=revoking?controlPrincipalId:readerPrincipalId;
  if(principal.id!==role)fail('scope_denied');const cert=revoking?certificate(request.connectionRef,true):active(request.connectionRef);
  if(request.tenantRef!==cert.row.tenant||request.assetRef!==cert.row.asset)fail('scope_denied');
  return{...livePolicy,connections:[binding(cert)],grants:[{principalId:role,tenantRef:cert.row.tenant,connectionRef:cert.row.connection,assetRef:cert.row.asset,operations:[request.operation]}]};
 }
 function guardContext(request,principal,expected){
  resolve(request,principal,base);const cert=active(request.connectionRef);if(expected&&cert.bodyDigest!==expected)fail('scope_denied');return cert;
 }
 async function current(cert,signal){
  const observed=await configuredVault.confirmActivation(cert.body.plan,{signal});
  if(observed.version!==cert.body.receipt.secretVersion||observed.secretDigest!==cert.body.plan.secretDigest)fail('secret_version_changed');
  const app=await secretApi.application(cert.slot,signal);
  if(app.secretVersion!==cert.body.plan.applicationVersion||app.clientId!==cert.body.plan.clientId)fail('secret_version_changed');
 }
 const operations={};
 for(const operation of C.OPERATIONS){
  const original=createSearchConsoleOperations({http,cursor})[operation];operations[operation]={...original,
   authorize:({request,principal})=>guardContext(request,principal),
   async execute(context){
    const request={operation,tenantRef:context.tenantRef,connectionRef:context.binding.connectionRef,assetRef:context.assetRef,payload:context.payload};
    const principal={id:context.principalId},cert=guardContext(request,principal);
    const guarded=async input=>{guardContext(request,principal,cert.bodyDigest);const result=await http(input);guardContext(request,principal,cert.bodyDigest);return result;};
    const work=createSearchConsoleOperations({http:guarded,cursor})[operation];const result=await work.execute(context);guardContext(request,principal,cert.bodyDigest);return result;
   }};
 }
 operations[C.REVOKE_OPERATION]=createSearchConsoleOperations({http,cursor})[C.REVOKE_OPERATION];
 const secrets={
  invalidate(ref){cache.get(ref)?.inner.invalidate(ref);},close(){for(const entry of cache.values())entry.inner.close();cache.clear();},
  async withSecret(selected,work,{signal,onRevoked,requiredScopes=[]}={}){
   const cert=active(selected.connectionRef),expected=cert.bodyDigest;
   if(canonical(selected)!==canonical(binding(cert)))fail('scope_denied');
   const guard=()=>{const live=active(selected.connectionRef);if(live.bodyDigest!==expected)fail('scope_denied');return live;};
   await current(cert,signal);guard();
   let entry=cache.get(selected.connectionRef);
   if(!entry){
    if(cache.size>=64)fail('rate_limited');
    const scopedClient={async send(command,options){
     guard();const input=command.input,name=command.constructor.name;
     if(!['DescribeSecretCommand','GetSecretValueCommand'].includes(name)||![cert.slot.secretArn,cert.slot.clientSecretArn].includes(input.SecretId))fail('scope_denied');
     if(name==='GetSecretValueCommand'&&(input.VersionStage!=='AWSCURRENT'||input.VersionId!==undefined))fail('scope_denied');
     const value=await client.send(command,options);guard();
     if(name==='GetSecretValueCommand'&&value.VersionId!==(input.SecretId===cert.slot.secretArn?cert.body.receipt.secretVersion:cert.body.plan.applicationVersion))fail('secret_version_changed');return value;
    }};
    const guardedHttp=async input=>{guard();const result=await http(input);guard();
     if(input.hostname==='oauth2.googleapis.com'&&result.scope!==undefined){
      if(typeof result.scope!=='string')fail('secret_unavailable');const actual=OAuth.normalizeScopes(result.scope.split(' ').filter(Boolean)),allowed=requiredScopesFor('search_console');
      if(actual.some(s=>!allowed.includes(s))||!actual.includes('https://www.googleapis.com/auth/webmasters.readonly'))fail('secret_unavailable');
     }return result;
    };
    entry={inner:createGoogleSecretStore({client:scopedClient,http:guardedHttp,accountId,prefix,kmsKeyArn,provider:C.PROVIDER,now,maxEntries:1})};cache.set(selected.connectionRef,entry);
   }
   return entry.inner.withSecret(selected,async token=>{guard();const value=await work(token);guard();await current(cert,signal);guard();return value;},
    {signal,onRevoked,requiredScopes:[...requiredScopes,'https://www.googleapis.com/auth/webmasters.readonly']});
  },
 };
 const broker=new Broker({store,policy:base,secrets,operations,policyResolver:{resolve},now,timeoutMs:25000});
 async function bootstrap({proof,owner,receipt}){
  const prepared=source(proof,owner),cert=prepared.body,r=cert.receipt;
  if(canonical(receipt)!==canonical(r))fail('scope_denied');
  await current(prepared);return store.transaction(()=>{
   const latest=source(proof,owner);if(latest.bodyDigest!==prepared.bodyDigest)fail('scope_denied');
   const previous=store.db.prepare('SELECT * FROM '+TABLE+' WHERE connection=?').get(r.connectionRef);
   if(previous){certificate(r.connectionRef);return{installed:true,connectionRef:r.connectionRef,tenantRef:previous.tenant,assetRef:previous.asset,certificateDigest:previous.body_digest};}
   if(r.validUntil<=clock()||store.db.prepare('SELECT COUNT(*) AS n FROM '+TABLE).get().n>=64)fail('oauth_flow_interrupted');
   if(store.backlog().pending>=base.maxBacklog)fail('audit_unavailable');
   store.assertAssetActive({tenantRef:'clinic:'+r.clinicId,connectionRef:r.connectionRef,assetRef:r.assetRef});
   store.db.prepare('INSERT INTO '+TABLE+' VALUES(?,?,?,?,?,?,?)').run(r.connectionRef,'clinic:'+r.clinicId,r.assetRef,r.attemptId,canonical(cert),prepared.bodyDigest,clock());
   store.seedConnection(r.connectionRef,{state:'active',expiresAt:cert.refreshTokenExpiresAt});
   store.appendAudit({version:2,eventId:randomUUID(),occurredAt:new Date(clock()).toISOString(),actorType:'service',actorId:owner.principalId,tenantRef:'clinic:'+r.clinicId,
    connectionRef:r.connectionRef,resourceRef:r.assetRef,correlationId:r.attemptId,policyVersion:base.version,operation:'google.search_console.discovery.read.v1',
    action:'integration.completed',result:'success',reason:'first_sc_read_authority_installed'});
   return{installed:true,connectionRef:r.connectionRef,tenantRef:'clinic:'+r.clinicId,assetRef:r.assetRef,certificateDigest:prepared.bodyDigest};
  });
 }
 const close=()=>{for(const controllers of broker.active.values())for(const controller of controllers)controller.abort();secrets.close();};
 return Object.freeze({broker,bootstrap,close});
}
module.exports={createFirstSearchConsoleReadOwner,TABLE};
