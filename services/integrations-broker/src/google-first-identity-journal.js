'use strict';
// Private Owner candidate. No routes, grants, provider client or secret loader.
const {createHash,randomUUID,timingSafeEqual}=require('node:crypto');
const {canonical}=require('./canonical');
const {BrokerError,fail}=require('./errors');
const {token,subject}=require('./google-oauth-secrets');
const {requiredScopesFor,SERVICES}=require('./google-first-identity-provider');
const T='google_first_identity_journal_v1',E='google_first_identity_events_v1',I='google_first_identity_live_asset_v1';
const RESERVED="stage_intent IS NOT NULL OR state IN ('prepared','exchanging','candidate_ready','stage_intent','candidate_staged')";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/,VERSION=/^[A-Za-z0-9-]{32,64}$/;
const STATES=Object.freeze(['prepared','exchanging','candidate_ready','stage_intent','candidate_staged','interrupted','aborted','expired']);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const hash=v=>createHash('sha256').update(v).digest('hex');
const same=(a,b)=>canonical(a)===canonical(b);
const metadataDigest=metadata=>hash(canonical(metadata));
const stateDigest=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))fail('invalid_request');return hash(value);};
const DDL=[`CREATE TABLE IF NOT EXISTS ${T} (
 id TEXT PRIMARY KEY,binding_digest TEXT NOT NULL,service TEXT NOT NULL,expires_at INTEGER NOT NULL,
 principal TEXT NOT NULL,tenant TEXT NOT NULL,connection TEXT NOT NULL,asset TEXT NOT NULL,
 state_hash TEXT UNIQUE,provider_context_digest TEXT,application_version TEXT,client_id TEXT,
 state TEXT NOT NULL CHECK(state IN ('prepared','exchanging','candidate_ready','stage_intent','candidate_staged','interrupted','aborted','expired')),
 code_digest TEXT UNIQUE,lease_digest TEXT,metadata TEXT,metadata_digest TEXT,stage_intent TEXT,receipt_digest TEXT,
 cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT`,
 `CREATE TABLE IF NOT EXISTS ${E} (id TEXT PRIMARY KEY,attempt TEXT NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL,occurred_at INTEGER NOT NULL,
 FOREIGN KEY(attempt) REFERENCES ${T}(id)) STRICT`,
 `CREATE UNIQUE INDEX IF NOT EXISTS ${I} ON ${T}(asset) WHERE ${RESERVED}`];
function createFirstGoogleJournal({store,now=Date.now,onTransition=()=>{}}={}){
 if(!store?.db?.prepare||typeof store.transaction!=='function'||typeof now!=='function'||typeof onTransition!=='function')fail('invalid_request');
 const permits=new WeakMap(),clock=()=>{const n=now();if(!Number.isSafeInteger(n)||n<=0)fail('invalid_request');return n;};
 const normalized=s=>s.replace('IF NOT EXISTS ','').replace(/\s+/g,' ').trim();
 store.transaction(()=>{
  for(const sql of DDL)store.db.exec(sql);
  for(let i=0;i<2;i++){
   const name=i?E:T,row=store.db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(name);
   if(!row||normalized(row.sql)!==normalized(DDL[i]))fail('invalid_request');
   const extras=store.db.prepare("SELECT type,sql,name FROM sqlite_schema WHERE tbl_name=? AND type<>'table'").all(name);
   if(extras.length!==(i?1:4)||extras.some(v=>v.name===I
    ?i!==0||v.type!=='index'||normalized(v.sql)!==normalized(DDL[2])
    :v.type!=='index'||v.sql!==null||!v.name.startsWith('sqlite_autoindex_'+name+'_')))fail('invalid_request');
  }
 });
 const get=id=>store.db.prepare(`SELECT * FROM ${T} WHERE id=?`).get(id);
 function proof(p){
  if(!exact(p,'attemptId,bindingDigest,service,expiresAt')||!UUID.test(p.attemptId)||!HASH.test(p.bindingDigest)
   ||!SERVICES.includes(p.service)||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=0)fail('invalid_request');
 }
 function owner(p,o){
  proof(p);if(!exact(o,'principalId,tenantRef,connectionRef,assetRef')||!/^\w[\w.:-]{0,127}$/.test(o.principalId)
   ||!/^clinic:[1-9][0-9]{0,9}$/.test(o.tenantRef)||Number(o.tenantRef.slice(7))>2147483647||o.connectionRef!=='google-first:'+p.attemptId)fail('scope_denied');
  const match=new RegExp('^google-oauth:'+p.service+':(clinic|group):([1-9][0-9]{0,9})$').exec(o.assetRef);
  if(!match||Number(match[2])>2147483647||match[1]==='clinic'&&o.tenantRef!=='clinic:'+match[2])fail('scope_denied');
 }
 function checked(p,o){
  owner(p,o);const row=get(p.attemptId);
  if(!row||row.binding_digest!==p.bindingDigest||row.service!==p.service||row.expires_at!==p.expiresAt
   ||row.principal!==o.principalId||row.tenant!==o.tenantRef||row.connection!==o.connectionRef||row.asset!==o.assetRef)fail('scope_denied');
  return row;
 }
 const dto=row=>({attemptId:row.id,bindingDigest:row.binding_digest,service:row.service,expiresAt:row.expires_at,
  state:row.state,authorizationConfirmed:false,connected:false});
 function event(row,reason){
  store.db.prepare(`INSERT INTO ${E} VALUES (?,?,?,?,?)`).run(randomUUID(),row.id,row.state,reason,clock());
  onTransition(Object.freeze({attemptId:row.id,state:row.state,reason}));
 }
 function update(row,patch,reason){
  const keys=Object.keys(patch);store.db.prepare(`UPDATE ${T} SET ${keys.map(k=>k+'=?').join(',')},updated_at=? WHERE id=?`)
   .run(...keys.map(k=>patch[k]),clock(),row.id);const next=get(row.id);event(next,reason);return next;
 }
 const fresh=row=>{if(row.expires_at<=clock())fail('oauth_flow_interrupted');};
 function validateMetadata(row,value){
  if(!exact(value,'version,attemptId,bindingDigest,service,provider,googleUserId,clientId,scopes,observedAt,accessExpiresAt,refreshTokenExpiresAt,connected,authorizationConfirmed')
   ||value.version!==1||value.attemptId!==row.id||value.bindingDigest!==row.binding_digest||value.service!==row.service
   ||value.provider!=='google_'+row.service||!subject(value.googleUserId)||value.clientId!==row.client_id
   ||!same(value.scopes,requiredScopesFor(row.service))||!Number.isSafeInteger(value.observedAt)||value.observedAt<row.created_at
   ||value.observedAt>clock()||!Number.isSafeInteger(value.accessExpiresAt)||value.accessExpiresAt<=clock()
   ||value.accessExpiresAt>value.observedAt+86400000||value.refreshTokenExpiresAt!==null
    &&(!Number.isSafeInteger(value.refreshTokenExpiresAt)||value.refreshTokenExpiresAt<=clock())
   ||value.connected!==false||value.authorizationConfirmed!==false)fail('oauth_credentials_incomplete');
  return canonical(value);
 }
 function validateIntent(row,value){
  if(!exact(value,'stageRequestId,versionId,digest,slotDigest,baselineVersion,metadataDigest')||!UUID.test(value.stageRequestId)
   ||value.stageRequestId===row.id||value.versionId!==row.id||!VERSION.test(value.baselineVersion)
   ||!['digest','slotDigest','metadataDigest'].every(k=>HASH.test(value[k]))||value.metadataDigest!==row.metadata_digest)fail('invalid_request');
  return canonical(value);
 }
 const service={
  prepare(p,o,context){
   owner(p,o);if(!exact(context,'stateHash,providerContextDigest,applicationVersion,clientId')||!HASH.test(context.stateHash)
    ||!HASH.test(context.providerContextDigest)||!VERSION.test(context.applicationVersion)||!token(context.clientId)||context.clientId.length>1024)fail('invalid_request');
   return store.transaction(()=>{
    const prior=get(p.attemptId);if(prior){const row=checked(p,o);if(row.state==='aborted'&&row.state_hash===null)return dto(row);
     if(row.state_hash!==context.stateHash||row.provider_context_digest!==context.providerContextDigest
      ||row.application_version!==context.applicationVersion||row.client_id!==context.clientId)fail('idempotency_conflict');return dto(row);}
    if(p.expiresAt<=clock()||p.expiresAt>clock()+600000)fail('oauth_flow_interrupted');
    const reserved=store.db.prepare(`SELECT * FROM ${T} WHERE asset=? AND (${RESERVED}) LIMIT 1`).get(o.assetRef);
    if(reserved){
     if(reserved.state!=='prepared'||reserved.expires_at>clock()||reserved.code_digest!==null||reserved.stage_intent!==null)fail('idempotency_conflict');
     update(reserved,{state:'expired'},'unused_reservation_expired');
    }
    store.db.prepare(`INSERT INTO ${T}(id,binding_digest,service,expires_at,principal,tenant,connection,asset,state_hash,provider_context_digest,application_version,client_id,state,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`).run(p.attemptId,p.bindingDigest,p.service,p.expiresAt,o.principalId,o.tenantRef,o.connectionRef,o.assetRef,
      context.stateHash,context.providerContextDigest,context.applicationVersion,context.clientId,clock(),clock());
    const row=get(p.attemptId);event(row,'prepared');return dto(row);
   });
  },
  read:(p,o)=>dto(checked(p,o)),
  consume(p,o,input){
   if(!exact(input,'state,code,providerContextDigest')||!HASH.test(input.providerContextDigest)||!Buffer.isBuffer(input.code)
    ||input.code.length>4096||!token(input.code.toString('utf8')))fail('invalid_request');
   const stateHash=stateDigest(input.state),codeDigest=hash(input.code),lease=randomUUID();
   const row=store.transaction(()=>{const row=checked(p,o);fresh(row);
    if(row.provider_context_digest!==input.providerContextDigest||!row.state_hash||!timingSafeEqual(Buffer.from(row.state_hash,'hex'),Buffer.from(stateHash,'hex')))fail('scope_denied');
    if(row.state!=='prepared')fail(row.state==='exchanging'?'outcome_unknown':'oauth_flow_interrupted');
    if(store.db.prepare(`SELECT 1 FROM ${T} WHERE code_digest=?`).get(codeDigest))fail('idempotency_conflict');
    return update(row,{state:'exchanging',code_digest:codeDigest,lease_digest:hash(lease)},'exchange_burned');
   });
   const permit=Object.freeze({});permits.set(permit,{p:{...p},o:{...o},leaseDigest:row.lease_digest,codeDigest});return permit;
  },
  exchangeReady(permit,metadata){
   const owned=permits.get(permit);if(!owned)fail('oauth_flow_interrupted');permits.delete(permit);
   try{return store.transaction(()=>{const row=checked(owned.p,owned.o);fresh(row);
    if(row.state!=='exchanging'||row.lease_digest!==owned.leaseDigest||row.code_digest!==owned.codeDigest)fail('outcome_unknown');
    const text=validateMetadata(row,metadata);return dto(update(row,{state:'candidate_ready',metadata:text,metadata_digest:metadataDigest(metadata),lease_digest:null},'provider_identity_received'));
   });}catch(error){try{service.interrupt(owned.p,owned.o);}catch{}throw error;}
  },
  exchangeFailed(permit){
   const owned=permits.get(permit);if(!owned)fail('oauth_flow_interrupted');permits.delete(permit);
   return store.transaction(()=>{const row=checked(owned.p,owned.o);
    if(row.state!=='exchanging'||row.lease_digest!==owned.leaseDigest)fail('outcome_unknown');
    return dto(update(row,{state:'interrupted',lease_digest:null},'exchange_outcome_unknown'));
   });
  },
  async runExchange(p,o,input,work){
   if(typeof work!=='function'||!Buffer.isBuffer(input?.code))fail('invalid_request');const code=Buffer.from(input.code);let permit;
   try{permit=service.consume(p,o,{...input,code});const metadata=await work(Object.freeze({code}));return service.exchangeReady(permit,metadata);}
   catch(error){if(permit)try{service.exchangeFailed(permit);}catch{}throw error instanceof BrokerError?new BrokerError(error.code):new BrokerError('outcome_unknown');}
   finally{code.fill(0);}
  },
  commitStageIntent(p,o,value){return store.transaction(()=>{const row=checked(p,o),text=validateIntent(row,value);
   if(['stage_intent','candidate_staged'].includes(row.state)){if(row.stage_intent!==text)fail('idempotency_conflict');return dto(row);}
   fresh(row);if(row.state!=='candidate_ready'||!row.metadata)fail('oauth_flow_interrupted');validateMetadata(row,JSON.parse(row.metadata));
   return dto(update(row,{state:'stage_intent',stage_intent:text},'candidate_stage_intended'));
  });},
  acceptStageReceipt(p,o,receipt){return store.transaction(()=>{
   const row=checked(p,o);if(!exact(receipt,'stageRequestId,versionId,digest,slotDigest,baselineVersion,metadataDigest,status,accessBlocked')
    ||receipt.status!=='staged'||receipt.accessBlocked!==true)fail('invalid_request');
   const {status,accessBlocked,...value}=receipt,text=validateIntent(row,value),receiptDigest=hash(canonical(receipt));
   if(row.stage_intent!==text)fail('idempotency_conflict');
   if(['candidate_staged','aborted'].includes(row.state)&&row.receipt_digest===receiptDigest)return dto(row);
   if(row.state!=='stage_intent')fail('outcome_unknown');
   return dto(update(row,{state:row.cancel_requested?'aborted':'candidate_staged',receipt_digest:receiptDigest},'candidate_stage_readback_confirmed'));
  });},
  getPrivateState(p,o){const row=checked(p,o);return {proof:{...p},scopeKey:row.asset.slice(('google-oauth:'+row.service+':').length),
   providerContextDigest:row.provider_context_digest,applicationVersion:row.application_version,clientId:row.client_id,
   metadata:row.metadata?JSON.parse(row.metadata):null,metadataDigest:row.metadata_digest,
   stageIntent:row.stage_intent?JSON.parse(row.stage_intent):null,cancelRequested:!!row.cancel_requested};},
  abort(p,o){owner(p,o);return store.transaction(()=>{
   let row=get(p.attemptId);if(!row){store.db.prepare(`INSERT INTO ${T}(id,binding_digest,service,expires_at,principal,tenant,connection,asset,state,cancel_requested,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,'aborted',1,?,?)`).run(p.attemptId,p.bindingDigest,p.service,p.expiresAt,o.principalId,o.tenantRef,o.connectionRef,o.assetRef,clock(),clock());row=get(p.attemptId);event(row,'abort_tombstone');return dto(row);}
   row=checked(p,o);if(['aborted','expired','interrupted'].includes(row.state))return dto(row);
   return dto(update(row,{state:row.state==='stage_intent'?'stage_intent':row.state==='exchanging'?'interrupted':'aborted',cancel_requested:1,lease_digest:null},'abort_requested'));
  });},
  interrupt(p,o){return store.transaction(()=>{const row=checked(p,o);
   if(!['prepared','exchanging','candidate_ready'].includes(row.state))return dto(row);
   return dto(update(row,{state:'interrupted',lease_digest:null},'owner_exchange_interrupted'));
  });},
  expire(p,o){return store.transaction(()=>{const row=checked(p,o);
   if(row.expires_at>clock()||!['prepared','exchanging','candidate_ready'].includes(row.state))return dto(row);
   return dto(update(row,{state:row.state==='exchanging'?'interrupted':'expired',lease_digest:null},'attempt_expired'));
  });},
 };
 return Object.freeze(service);
}
module.exports={createFirstGoogleJournal,metadataDigest,stateDigest,STATES,TABLE:T,EVENTS_TABLE:E};
