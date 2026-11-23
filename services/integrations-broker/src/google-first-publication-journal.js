'use strict';
// Private first-only side ledger. No RPC, provider, vault writer or reuse path.
const {createHash,randomUUID}=require('node:crypto');
const {canonical}=require('./canonical'),{fail}=require('./errors');
const {metadataDigest,TABLE:SOURCE_TABLE}=require('./google-first-identity-journal');
const {SERVICES,requiredScopesFor}=require('./google-first-identity-provider');
const DOMAIN='clinicaclick/google-first-publication/1';
const TABLE='google_first_publications_v1',EVENTS='google_first_publication_events_v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/,VERSION=/^[A-Za-z0-9-]{32,64}$/;
const ASSETS={business_profile:/^gbp:[1-9]\d{0,29}:[1-9]\d{0,29}$/,search_console:/^sc:[a-f0-9]{64}$/,
 analytics:/^ga4:[1-9]\d{0,19}$/,ads:/^ads:(?!0000000000$)\d{10}$/};
const STATES=Object.freeze(['approved','activation_intent','confirmed','cancelled','expired']);
const hash=v=>createHash('sha256').update(v).digest('hex');
const digest=v=>hash(canonical(v));
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.split(',').length&&keys.split(',').every(k=>Object.hasOwn(v,k));
const positive=v=>Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const typed=(v,re)=>typeof v==='string'&&re.test(v);
const DDL=[`CREATE TABLE IF NOT EXISTS ${TABLE} (
 attempt_id TEXT PRIMARY KEY,binding_digest TEXT NOT NULL,service TEXT NOT NULL,expires_at INTEGER NOT NULL,
 principal TEXT NOT NULL,tenant TEXT NOT NULL,connection TEXT NOT NULL,asset TEXT NOT NULL,clinic_digest TEXT NOT NULL,
 selection TEXT,selection_digest TEXT,credential TEXT,credential_digest TEXT,approval TEXT,approval_digest TEXT,
 state TEXT NOT NULL CHECK(state IN ('approved','activation_intent','confirmed','cancelled','expired')),
 activation_request_id TEXT UNIQUE,activation_intent TEXT,activation_readback_digest TEXT,
 receipt TEXT,receipt_digest TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT`,
 `CREATE TABLE IF NOT EXISTS ${EVENTS}(id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL,
 FOREIGN KEY(attempt_id) REFERENCES ${TABLE}(attempt_id)) STRICT`];

function createFirstGooglePublicationJournal({store,journal,approvedScopes,now=Date.now,onTransition=()=>{}}={}){
 if(!store?.db?.prepare||typeof store.transaction!=='function'||!journal?.read||!journal?.getPrivateState
  ||typeof now!=='function'||typeof onTransition!=='function'||!Array.isArray(approvedScopes)||!approvedScopes.length||approvedScopes.length>64)fail('invalid_request');
 const scopes=new Map(),permits=new WeakMap();
 for(const value of approvedScopes){
  if(!exact(value,'scopeKey,clinicIds,services')||!typed(value.scopeKey,/^(clinic|group):[1-9]\d{0,9}$/)||!positive(Number(value.scopeKey.split(':')[1]))
   ||!Array.isArray(value.clinicIds)||!value.clinicIds.length||value.clinicIds.length>1000||value.clinicIds.some((id,i,ids)=>!positive(id)||i&&id<=ids[i-1])
   ||value.scopeKey.startsWith('clinic:')&&(value.clinicIds.length!==1||value.scopeKey!=='clinic:'+value.clinicIds[0])
   ||!Array.isArray(value.services)||!value.services.length||value.services.some(s=>!SERVICES.includes(s))||new Set(value.services).size!==value.services.length||scopes.has(value.scopeKey))fail('invalid_request');
  scopes.set(value.scopeKey,Object.freeze({scopeKey:value.scopeKey,clinicIds:Object.freeze([...value.clinicIds]),services:Object.freeze([...value.services])}));
 }
 const clock=()=>{const at=now();if(!Number.isSafeInteger(at)||at<=0)fail('invalid_request');return at;};
 const normalize=sql=>sql.replace('IF NOT EXISTS ','').replace(/\s+/g,' ').trim();
 store.transaction(()=>{for(const sql of DDL)store.db.exec(sql);for(let i=0;i<2;i++){
  const table=i?EVENTS:TABLE,definition=store.db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table);
  if(!definition||normalize(definition.sql)!==normalize(DDL[i]))fail('invalid_request');
  const extra=store.db.prepare("SELECT * FROM sqlite_schema WHERE tbl_name=? AND type<>'table'").all(table);
  if(extra.length!==(i?1:2)||extra.some(r=>r.type!=='index'||r.sql!==null||!r.name.startsWith('sqlite_autoindex_'+table+'_')))fail('invalid_request');
 }});
 const get=id=>store.db.prepare('SELECT * FROM '+TABLE+' WHERE attempt_id=?').get(id);
 function context(proof,owner){
  if(!exact(proof,'attemptId,bindingDigest,service,expiresAt')||!typed(proof.attemptId,UUID)||!typed(proof.bindingDigest,SHA)
   ||!SERVICES.includes(proof.service)||!Number.isSafeInteger(proof.expiresAt)||proof.expiresAt<=0
   ||!exact(owner,'principalId,tenantRef,connectionRef,assetRef')||!typed(owner.principalId,/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/)
   ||owner.connectionRef!=='google-first:'+proof.attemptId)fail('scope_denied');
  const prefix='google-oauth:'+proof.service+':',scope=typeof owner.assetRef==='string'&&owner.assetRef.startsWith(prefix)?scopes.get(owner.assetRef.slice(prefix.length)):null;
  if(!scope||owner.tenantRef!=='clinic:'+scope.clinicIds[0]||!scope.services.includes(proof.service))fail('scope_denied');
  return{scope,clinicDigest:hash(JSON.stringify(scope.clinicIds))};
 }
 function bound(proof,owner){
  const ctx=context(proof,owner),row=get(proof.attemptId);
  if(!row||row.binding_digest!==proof.bindingDigest||row.service!==proof.service||row.expires_at!==proof.expiresAt
   ||row.principal!==owner.principalId||row.tenant!==owner.tenantRef||row.connection!==owner.connectionRef||row.asset!==owner.assetRef
   ||row.clinic_digest!==ctx.clinicDigest)fail('scope_denied');validateStored(proof,owner,row);return row;
 }
 function source(proof,owner,allowCancelled=false){
  const dto=journal.read(proof,owner),state=journal.getPrivateState(proof,owner),m=state.metadata,s=state.stageIntent;
  // Read the authoritative source under THIS store's write transaction too.
  // An abort using another connection to this SQLite file cannot interleave.
  const raw=store.db.prepare('SELECT * FROM '+SOURCE_TABLE+' WHERE id=?').get(proof.attemptId);
  if(!raw||raw.state!==dto.state||raw.binding_digest!==proof.bindingDigest||raw.service!==proof.service||raw.expires_at!==proof.expiresAt
   ||raw.principal!==owner.principalId||raw.tenant!==owner.tenantRef||raw.connection!==owner.connectionRef||raw.asset!==owner.assetRef
   ||raw.metadata!==(m?canonical(m):null)||raw.stage_intent!==(s?canonical(s):null)||!!raw.cancel_requested!==state.cancelRequested)fail('scope_denied');
  if(!['candidate_staged',...(allowCancelled?['aborted','expired']:[])].includes(dto.state)||!m||!s
   ||state.scopeKey!==context(proof,owner).scope.scopeKey||state.metadataDigest!==metadataDigest(m)||s.metadataDigest!==state.metadataDigest
   ||s.versionId!==proof.attemptId||!typed(s.stageRequestId,UUID)||!typed(s.digest,SHA)||!typed(s.slotDigest,SHA)||!typed(s.baselineVersion,VERSION)
   ||!typed(state.applicationVersion,VERSION)||!typed(state.providerContextDigest,SHA)
   ||m.attemptId!==proof.attemptId||m.bindingDigest!==proof.bindingDigest||m.service!==proof.service||m.provider!=='google_'+proof.service
   ||!typed(m.googleUserId,/^(?!unknown$)[A-Za-z0-9._-]{1,128}$/)||m.clientId!==state.clientId||typeof m.clientId!=='string'
   ||JSON.stringify(m.scopes)!==JSON.stringify(requiredScopesFor(proof.service)))fail('oauth_flow_interrupted');
  const credential={scopeKey:state.scopeKey,providerContextDigest:state.providerContextDigest,applicationVersion:state.applicationVersion,
   clientId:m.clientId,googleUserId:m.googleUserId,metadataDigest:state.metadataDigest,stageIntent:s,
   providerObservedAt:m.observedAt,accessExpiresAt:m.accessExpiresAt,refreshTokenExpiresAt:m.refreshTokenExpiresAt};
  const cancelled=state.cancelRequested||dto.state!=='candidate_staged';
  return{credential,credentialDigest:digest([DOMAIN,'credential',credential]),cancelled};
 }
 function select(proof,owner,selection){
  const ctx=context(proof,owner);
  if(!exact(selection,'scopeKey,clinicId,assetRef')||selection.scopeKey!==ctx.scope.scopeKey||!ctx.scope.clinicIds.includes(selection.clinicId)
   ||!typed(selection.assetRef,ASSETS[proof.service]))fail('scope_denied');
  const selectionDigest=digest([DOMAIN,'selection',proof,owner,ctx.clinicDigest,selection]);
  return{...ctx,selectionDigest};
 }
 function json(text){try{const value=JSON.parse(text);if(canonical(value)!==text)fail('idempotency_conflict');return value;}catch{fail('idempotency_conflict');}}
 function validateStored(proof,owner,row){
  if(row.selection===null){
   if(row.state!=='cancelled'||!row.cancel_requested||['selection_digest','credential','credential_digest','approval','approval_digest','activation_request_id','activation_intent','activation_readback_digest','receipt','receipt_digest'].some(k=>row[k]!==null))fail('idempotency_conflict');
   return;
  }
  const selection=json(row.selection),credential=json(row.credential),approval=json(row.approval);
  if(select(proof,owner,selection).selectionDigest!==row.selection_digest
   ||!exact(credential,'scopeKey,providerContextDigest,applicationVersion,clientId,googleUserId,metadataDigest,stageIntent,providerObservedAt,accessExpiresAt,refreshTokenExpiresAt')
   ||digest([DOMAIN,'credential',credential])!==row.credential_digest||source(proof,owner,true).credentialDigest!==row.credential_digest
   ||!exact(approval,'approvalId,selectionDigest,credentialDigest,observedAt,validUntil'+(proof.service==='search_console'?',resource':''))
   ||digest(approval)!==row.approval_digest||approval.selectionDigest!==row.selection_digest||approval.credentialDigest!==row.credential_digest
   ||!typed(approval.approvalId,UUID)||!Number.isSafeInteger(approval.observedAt)||approval.observedAt<credential.providerObservedAt||approval.observedAt>row.created_at
   ||!Number.isSafeInteger(approval.validUntil)||approval.validUntil<=approval.observedAt
   ||approval.validUntil>Math.min(proof.expiresAt,approval.observedAt+60000,credential.accessExpiresAt,credential.refreshTokenExpiresAt??Infinity))fail('idempotency_conflict');
  resourceMetadata(proof.service,selection,approval);
  let intent;
  if(row.activation_intent){intent=json(row.activation_intent);
   if(!exact(intent,'activationRequestId,selectionDigest,credentialDigest,approvalDigest,vaultPlan')||!typed(intent.activationRequestId,UUID)
    ||intent.activationRequestId!==row.activation_request_id||intent.selectionDigest!==row.selection_digest||intent.credentialDigest!==row.credential_digest
    ||intent.approvalDigest!==row.approval_digest||canonical(intent.vaultPlan)!==canonical(vaultPlan(proof,credential)))fail('idempotency_conflict');
  }else if(row.activation_request_id!==null||row.activation_readback_digest!==null||row.receipt!==null||row.receipt_digest!==null||row.state==='activation_intent'||row.state==='confirmed')fail('idempotency_conflict');
  if(row.activation_readback_digest&&digest({activationRequestId:intent.activationRequestId,version:intent.vaultPlan.version,secretDigest:intent.vaultPlan.secretDigest,status:'confirmed_current'})!==row.activation_readback_digest)fail('idempotency_conflict');
  if(row.receipt){const receipt=json(row.receipt),resource=resourceMetadata(proof.service,selection,approval);
   const fields='attemptId,scopeKey,service,clinicId,assetRef,bindingDigest,clinicSetDigest,receiptId,googleUserId,connectionRef,secretVersion,mode,observedAt,validUntil,status'+(resource?',resource':'');
   if(!exact(receipt,fields)||digest(receipt)!==row.receipt_digest||!row.activation_readback_digest||!typed(receipt.receiptId,UUID)
    ||receipt.attemptId!==proof.attemptId||receipt.scopeKey!==selection.scopeKey||receipt.service!==proof.service||receipt.clinicId!==selection.clinicId
    ||receipt.assetRef!==selection.assetRef||receipt.bindingDigest!==proof.bindingDigest||receipt.clinicSetDigest!==row.clinic_digest
    ||receipt.googleUserId!==credential.googleUserId||receipt.connectionRef!=='google-first:'+proof.service+':'+selection.scopeKey
    ||receipt.secretVersion!==proof.attemptId||receipt.mode!=='provisioned'||receipt.status!=='confirmed_resource_access'
    ||!Number.isSafeInteger(receipt.observedAt)||receipt.observedAt<row.created_at||receipt.observedAt>row.updated_at
    ||receipt.validUntil!==approval.validUntil||resource&&canonical(receipt.resource)!==canonical(resource))fail('idempotency_conflict');
  }else if(row.receipt_digest!==null||row.state==='confirmed')fail('idempotency_conflict');
  if(row.state==='approved'&&(row.activation_intent||row.cancel_requested))fail('idempotency_conflict');
 }
 function emit(row,reason){
  store.db.prepare('INSERT INTO '+EVENTS+' VALUES(?,?,?,?,?)').run(randomUUID(),row.attempt_id,row.state,reason,clock());
  onTransition(Object.freeze({attemptId:row.attempt_id,state:row.state,reason}));
 }
 function update(row,patch,reason){
  const fields=Object.keys(patch);store.db.prepare('UPDATE '+TABLE+' SET '+fields.map(k=>k+'=?').join(',')+',updated_at=? WHERE attempt_id=?')
   .run(...fields.map(k=>patch[k]),clock(),row.attempt_id);const next=get(row.attempt_id);emit(next,reason);return next;
 }
 const publicState=row=>({attemptId:row.attempt_id,state:row.state,effectPossible:row.activation_intent!==null,
  receipt:row.state==='confirmed'&&!row.cancel_requested&&row.receipt&&JSON.parse(row.receipt).validUntil>clock()?JSON.parse(row.receipt):null});
 function safeState(row,proof,owner){
  const projected=publicState(row);
  if(projected.receipt){const saved=source(proof,owner,true);
   if(saved.cancelled||saved.credentialDigest!==row.credential_digest||row.cancel_requested)projected.receipt=null;
   else try{fresh(proof,saved.credential,JSON.parse(row.approval));}catch{projected.receipt=null;}
  }
  return projected;
 }
 function resourceMetadata(service,selection,approval){
  if(service!=='search_console')return null;
  if(!exact(approval.resource,'siteUrl,permissionLevel'))fail('invalid_request');
  const site=require('./google-search-console-contract').site(approval.resource.siteUrl);
  if(site.assetRef!==selection.assetRef||site.siteUrl!==approval.resource.siteUrl)fail('scope_denied');
  return require('./google-property-discovery-contract').projectSC(approval.resource,site.siteUrl);
 }
 function vaultPlan(proof,credential){return{...proof,scopeKey:credential.scopeKey,slotDigest:credential.stageIntent.slotDigest,
  applicationVersion:credential.applicationVersion,version:proof.attemptId,secretDigest:credential.stageIntent.digest,googleUserId:credential.googleUserId,
  clientId:credential.clientId,refreshTokenExpiresAt:credential.refreshTokenExpiresAt,baselineVersion:credential.stageIntent.baselineVersion,metadataDigest:credential.metadataDigest};}
 function fresh(proof,credential,approval){
  const at=clock();if(proof.expiresAt<=at||credential.accessExpiresAt<=at||credential.refreshTokenExpiresAt!==null&&credential.refreshTokenExpiresAt<=at
   ||approval.validUntil<=at)fail('oauth_flow_interrupted');
 }
 function cancelLocked(proof,owner){
   if(store.db.isTransaction!==true)fail('invalid_request');
   const ctx=context(proof,owner),prior=get(proof.attemptId);
   if(!prior){store.db.prepare(`INSERT INTO ${TABLE}(attempt_id,binding_digest,service,expires_at,principal,tenant,connection,asset,clinic_digest,state,cancel_requested,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'cancelled',1,?,?)`).run(proof.attemptId,proof.bindingDigest,proof.service,proof.expiresAt,owner.principalId,owner.tenantRef,owner.connectionRef,owner.assetRef,ctx.clinicDigest,clock(),clock());
    const row=get(proof.attemptId);emit(row,'cancel_tombstone');return publicState(row);}
   const row=bound(proof,owner);if(row.cancel_requested)return safeState(row,proof,owner);
   return publicState(update(row,{state:row.state==='activation_intent'?'activation_intent':'cancelled',cancel_requested:1},'publication_cancel_requested'));
 }
 const service={
  preflight(proof,owner,selection){return store.transaction(()=>{const selected=select(proof,owner,selection),saved=source(proof,owner);
   if(saved.cancelled)fail('oauth_flow_interrupted');
   if(get(proof.attemptId)){const row=bound(proof,owner);if(row.cancel_requested||['cancelled','expired'].includes(row.state))fail('oauth_flow_interrupted');}
   fresh(proof,saved.credential,{validUntil:proof.expiresAt});
   return Object.freeze({selectionDigest:selected.selectionDigest,credentialDigest:saved.credentialDigest,
    clinicSetDigest:selected.clinicDigest,vaultPlan:vaultPlan(proof,saved.credential)});
  });},
  approve(proof,owner,selection,approval){return store.transaction(()=>{
   const selected=select(proof,owner,selection),saved=source(proof,owner);
   if(saved.cancelled||!exact(approval,'approvalId,selectionDigest,credentialDigest,observedAt,validUntil'+(proof.service==='search_console'?',resource':''))||!typed(approval.approvalId,UUID)
    ||approval.selectionDigest!==selected.selectionDigest||approval.credentialDigest!==saved.credentialDigest
    ||!Number.isSafeInteger(approval.observedAt)||approval.observedAt<saved.credential.providerObservedAt||approval.observedAt>clock()||!Number.isSafeInteger(approval.validUntil)
    ||approval.validUntil>Math.min(proof.expiresAt,approval.observedAt+60000,saved.credential.accessExpiresAt,saved.credential.refreshTokenExpiresAt??Infinity))fail('invalid_request');
   resourceMetadata(proof.service,selection,approval);fresh(proof,saved.credential,approval);
   const row=get(proof.attemptId),text=canonical(approval);
   if(row){const checked=bound(proof,owner);
    if(checked.selection_digest!==selected.selectionDigest||checked.credential_digest!==saved.credentialDigest||checked.approval!==text)fail('idempotency_conflict');
    if(['cancelled','expired'].includes(checked.state))fail('oauth_flow_interrupted');return safeState(checked,proof,owner);}
   store.db.prepare(`INSERT INTO ${TABLE}(attempt_id,binding_digest,service,expires_at,principal,tenant,connection,asset,clinic_digest,
    selection,selection_digest,credential,credential_digest,approval,approval_digest,state,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',?,?)`).run(proof.attemptId,proof.bindingDigest,proof.service,proof.expiresAt,
     owner.principalId,owner.tenantRef,owner.connectionRef,owner.assetRef,selected.clinicDigest,canonical(selection),selected.selectionDigest,
     canonical(saved.credential),saved.credentialDigest,text,digest(approval),clock(),clock());
   const next=get(proof.attemptId);emit(next,'native_resource_approved');return publicState(next);
  });},
  commitActivationIntent(proof,owner,input){
   if(!exact(input,'activationRequestId')||!typed(input.activationRequestId,UUID)||input.activationRequestId===proof?.attemptId)fail('invalid_request');
   const result=store.transaction(()=>{
    const row=bound(proof,owner),saved=source(proof,owner);
    if(row.credential_digest!==saved.credentialDigest)fail('idempotency_conflict');
    if(row.activation_intent){if(row.activation_request_id!==input.activationRequestId)fail('idempotency_conflict');fail('outcome_unknown');}
    if(row.state!=='approved'||row.cancel_requested||saved.cancelled)fail('oauth_flow_interrupted');
    const approval=JSON.parse(row.approval);fresh(proof,saved.credential,approval);
    const intent={activationRequestId:input.activationRequestId,selectionDigest:row.selection_digest,credentialDigest:row.credential_digest,
     approvalDigest:row.approval_digest,vaultPlan:vaultPlan(proof,saved.credential)};
    return update(row,{state:'activation_intent',activation_request_id:input.activationRequestId,activation_intent:canonical(intent)},'activation_intended');
   });
   const permit=Object.freeze({});permits.set(permit,{proof:{...proof},owner:{...owner}});return permit;
  },
  consumeActivationPermit(permit,proof,owner){
   const held=permits.get(permit);if(!held||canonical(held.proof)!==canonical(proof)||canonical(held.owner)!==canonical(owner))fail('oauth_flow_interrupted');
   permits.delete(permit);return store.transaction(()=>{const row=bound(proof,owner),saved=source(proof,owner);
    if(row.state!=='activation_intent'||row.cancel_requested||saved.cancelled||row.credential_digest!==saved.credentialDigest)fail('oauth_flow_interrupted');
    fresh(proof,saved.credential,JSON.parse(row.approval));return true;
   });
  },
  acceptActivationReceipt(proof,owner,receipt){return store.transaction(()=>{
   const row=bound(proof,owner);
   if(!exact(receipt,'activationRequestId,version,secretDigest,status')||receipt.status!=='confirmed_current'||!row.activation_intent)fail('invalid_request');
   const intent=JSON.parse(row.activation_intent),readbackDigest=digest(receipt);
   if(receipt.activationRequestId!==intent.activationRequestId||receipt.version!==intent.vaultPlan.version||receipt.secretDigest!==intent.vaultPlan.secretDigest)fail('idempotency_conflict');
   if(row.activation_readback_digest){if(row.activation_readback_digest!==readbackDigest)fail('idempotency_conflict');return safeState(row,proof,owner);}
   if(row.state!=='activation_intent')fail('outcome_unknown');
   const saved=source(proof,owner,true);
   if(saved.credentialDigest!==row.credential_digest)fail('idempotency_conflict');
   const approval=JSON.parse(row.approval),cancelled=!!row.cancel_requested||saved.cancelled;
   const expired=proof.expiresAt<=clock()||approval.validUntil<=clock()||saved.credential.accessExpiresAt<=clock()
    ||saved.credential.refreshTokenExpiresAt!==null&&saved.credential.refreshTokenExpiresAt<=clock();
   if(cancelled||expired)return publicState(update(row,{state:cancelled?'cancelled':'expired',activation_readback_digest:readbackDigest},'activation_observed_after_close'));
   const selection=JSON.parse(row.selection),resource=resourceMetadata(proof.service,selection,approval),publication={attemptId:proof.attemptId,scopeKey:selection.scopeKey,service:proof.service,clinicId:selection.clinicId,
    assetRef:selection.assetRef,bindingDigest:proof.bindingDigest,clinicSetDigest:row.clinic_digest,receiptId:randomUUID(),googleUserId:saved.credential.googleUserId,
    connectionRef:'google-first:'+proof.service+':'+selection.scopeKey,secretVersion:proof.attemptId,mode:'provisioned',observedAt:clock(),
    validUntil:approval.validUntil,status:'confirmed_resource_access',...(resource?{resource}:{} )};
   return publicState(update(row,{state:'confirmed',activation_readback_digest:readbackDigest,receipt:canonical(publication),receipt_digest:digest(publication)},'publication_receipt_confirmed'));
  });},
  read:(proof,owner)=>store.transaction(()=>safeState(bound(proof,owner),proof,owner)),
  getPrivateState(proof,owner){const row=bound(proof,owner);return{
   state:row.state,selection:row.selection?JSON.parse(row.selection):null,selectionDigest:row.selection_digest,
   credentialDigest:row.credential_digest,approval:row.approval?JSON.parse(row.approval):null,
   activationIntent:row.activation_intent?JSON.parse(row.activation_intent):null,
   activationReadbackDigest:row.activation_readback_digest,receipt:row.receipt?JSON.parse(row.receipt):null,cancelRequested:!!row.cancel_requested};},
  cancel:(proof,owner)=>store.transaction(()=>cancelLocked(proof,owner)),
  cancelLocked,
  expire(proof,owner){return store.transaction(()=>{
   const row=bound(proof,owner),approval=row.approval?JSON.parse(row.approval):null;
   if(row.state!=='approved'||proof.expiresAt>clock()&&approval?.validUntil>clock())return safeState(row,proof,owner);
   return publicState(update(row,{state:'expired'},'publication_expired'));
  });},
 };
 return Object.freeze(service);
}
module.exports={createFirstGooglePublicationJournal,TABLE,EVENTS,STATES,DOMAIN};
