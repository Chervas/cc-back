'use strict';
const {fail}=require('./errors'),{eventFor}=require('./audit'),{canonical}=require('./canonical');
const C=require('./meta-marketing-oauth-contract'),B=require('./meta-marketing-business-issuer'),K=require('./meta-marketing-credential-shape');
const T=require('./meta-marketing-credential-maintenance-contract'),E=require('./meta-marketing-enrollment-contract'),D=require('./meta-marketing-discovery-contract'),R=require('./meta-marketing-credential-renewal-contract');
function createMetaMarketingCredentialMaintenance({store,epochs,enrollment,secrets,http,businessHttp,userHealthHttp,environment,config,now=Date.now}){
 if(config)B.config(config);const roles=E.roles(environment),running=new Map();let closed=false;
 store.db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_credential_maintenance(
  id TEXT PRIMARY KEY,enrollment TEXT NOT NULL,principal TEXT NOT NULL,tenant TEXT NOT NULL,connection TEXT NOT NULL,scope TEXT NOT NULL,
  expected_epoch INTEGER NOT NULL,expected_version TEXT NOT NULL,expected_digest TEXT NOT NULL,grant_digest TEXT NOT NULL,asset_digest TEXT NOT NULL,
  state TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,provider_intent_at INTEGER,candidate_digest TEXT,candidate_metadata TEXT,
  command_id TEXT NOT NULL,command_digest TEXT NOT NULL,last_error TEXT,not_applied_at INTEGER,retry_observed_at INTEGER);
  CREATE UNIQUE INDEX IF NOT EXISTS meta_marketing_maintenance_pending ON meta_marketing_credential_maintenance(enrollment) WHERE state IN ('processing','not_applied','staged','interrupted');`);
 const get=id=>store.db.prepare('SELECT * FROM meta_marketing_credential_maintenance WHERE id=?').get(id);
 const expected=row=>({expectedEpoch:row.expected_epoch,expectedVersionId:row.expected_version,expectedCandidateDigest:row.expected_digest});
 function authority(request,base,row){
  const v=enrollment.renewalAuthority(row.enrollment,base);if(!K.business(v.binding)||v.credential.metadata.tokenType!=='SYSTEM_USER')fail('operation_denied');
  if(v.row.tenant!==row.tenant||v.row.connection!==row.connection||v.row.scope!==row.scope||epochs.grantDigest(v.row)!==row.grant_digest||R.assetSetDigest(v.assets)!==row.asset_digest)fail('scope_denied');return v;
 }
 function owned(request,row){if(row&&(row.tenant!==request.tenantRef||row.connection!==request.connectionRef||row.scope!==request.assetRef||row.principal!==roles.control))fail('scope_denied');return row;}
 function view(request,base,row){if(!row)return {maintenanceId:request.payload.maintenanceId,enrollmentId:null,status:'not_found',effectiveCredential:null,candidate:null,activationApplied:false};
  const v=authority(request,base,row);return {maintenanceId:row.id,enrollmentId:row.enrollment,status:row.state,effectiveCredential:epochs.view(v.credential),
   candidate:['staged','active'].includes(row.state)?{versionId:row.id,digest:row.candidate_digest,metadata:JSON.parse(row.candidate_metadata)}:null,
   activationApplied:row.state==='active'&&v.credential.versionId===row.id&&v.credential.digest===row.candidate_digest};}
 async function health({request,principal,binding:base,policy}){
  const p=request.payload,b=C.bindingFor(base);if(principal.id!==roles.control||request.tenantRef!=='clinic:'+b.clinicIds[0]||request.assetRef!=='meta-enroll:'+b.scopeKey)fail('scope_denied');
  const authPin=C.hash(JSON.stringify([principal.id,principal.keyId,principal.publicKey])),basePin=C.fingerprint(base),controller=new AbortController(),signal=controller.signal,timer=setTimeout(()=>controller.abort(),25000);timer.unref?.();
  function check(){if(closed||signal.aborted)fail('provider_timeout');const key=policy.principals.find(v=>v.id===principal.id),live=policy.connections.find(v=>v.connectionRef===base.connectionRef);
   if(!key?.enabled||C.hash(JSON.stringify([key.id,key.keyId,key.publicKey]))!==authPin||C.fingerprint(live)!==basePin)fail('scope_denied');require('./auth').authorize(key,request,policy);store.connection(base.connectionRef,now());store.assertAssetActive(request);
   const v=enrollment.renewalAuthority(p.enrollmentId,base);if(!K.business(v.binding)&&v.credential.metadata.tokenType!=='USER')fail('operation_denied');epochs.expected(v.credential,p);return v;
  }
  function auditHealth(result,reason){if(store.backlog().pending>=policy.maxBacklog)fail('audit_unavailable');store.appendAudit(eventFor(request,principal,policy,'integration.completed',result,reason,now()));}
  function result(v,metadata,reason=null){check();auditHealth(reason?'denied':'success',reason?'meta_credential_maintenance_health_denied':'meta_credential_maintenance_health_verified');const bound=key=>{const values=[v.credential.metadata[key],metadata[key]].filter(value=>value!==null);return values.length?Math.min(...values):null;};return {requestId:request.requestId,data:{enrollmentId:v.row.id,epoch:v.credential.epoch,versionId:v.credential.versionId,digest:v.credential.digest,verifiedAt:now(),expiresAt:bound('expiresAt'),dataAccessExpiresAt:bound('dataAccessExpiresAt'),healthy:reason===null,reason},replayed:false};}
  try{const v=check();if(store.backlog().pending+2>policy.maxBacklog)fail('audit_unavailable');store.appendAudit(eventFor(request,principal,policy,'integration.requested','accepted','meta_credential_maintenance_requested',now()));return await secrets.withCandidate(v.binding,v.credential.flow,v.credential.digest,async borrowed=>{
   const inspector=K.business(v.binding)?businessHttp:userHealthHttp;if(typeof inspector?.inspect!=='function')fail('operation_denied');
   let inspected;try{inspected=await inspector.inspect({binding:v.binding,token:borrowed.token,appSecret:borrowed.appSecret,signal,authorize:check});}
   catch(error){if(error.code==='credential_revoked')return result(v,v.credential.metadata,'credential_revoked');if(['debug_required_scope_missing','business_management_denied'].includes(error.credentialValidationReason))return result(v,v.credential.metadata,'permissions_lost');throw error;}
   if((K.business(v.binding)?B.identityKeys(v.credential.metadata):['appId','subjectId','tokenType']).some(k=>inspected[k]!==v.credential.metadata[k]))fail('oauth_identity_mismatch');
   if(['expiresAt','dataAccessExpiresAt'].some(key=>[v.credential.metadata[key],inspected[key]].some(value=>value!==null&&value<=now())))return result(v,inspected,'credential_expired');
   try{enrollment.assertRenewalCredential(p.enrollmentId,v.binding,inspected);}catch(error){check();if(error.code==='scope_denied')return result(v,inspected,'permissions_lost');throw error;}
   if(require('./meta-marketing-agency-contract').isBinding(v.binding)){if(typeof businessHttp.verifyPages!=='function')fail('operation_denied');try{await businessHttp.verifyPages({binding:v.binding,...borrowed,metadata:inspected,assets:v.assets,signal,authorize:check});}catch(error){if(error.credentialValidationReason==='page_lead_access_denied')return result(v,inspected,'permissions_lost');throw error;}}
   let inventory;try{inventory=await http.discover({binding:v.binding,...borrowed,metadata:inspected,signal,authorize:check});}catch(error){if(error.code==='credential_revoked')fail('provider_failed');throw error;}
   D.checkAssets(inventory,inspected);if(v.assets.some(a=>!inventory.some(d=>JSON.stringify(E.identity(d))===JSON.stringify(E.identity(a)))))return result(v,inspected,'permissions_lost');
   const after=await inspector.inspect({binding:v.binding,token:borrowed.token,appSecret:borrowed.appSecret,signal,authorize:check});
   if(JSON.stringify(after)!==JSON.stringify(inspected))fail('secret_version_changed');return result(v,after);
  },signal,{retentionStage:v.credential.retentionStage});}catch(error){try{auditHealth('unknown','meta_credential_maintenance_health_unavailable');}catch{}throw require('./meta-marketing-graph-pacing').safeError(error,'internal_error');}finally{clearTimeout(timer);}
 }
 async function execute({request,principal,binding:base,policy}){
  const name=T.validate(request.operation,request.payload);if(name==='health')return health({request,principal,binding:base,policy});const p=request.payload,id=p.maintenanceId,b=C.bindingFor(base);
  if(principal.id!==roles.control||request.tenantRef!=='clinic:'+b.clinicIds[0]||request.assetRef!=='meta-enroll:'+b.scopeKey)fail('scope_denied');
  let row=owned(request,get(id));if(name==='status'&&!row)return {requestId:request.requestId,data:view(request,base,null),replayed:false};
  if(row&&name==='rotate'&&(p.enrollmentId!==row.enrollment||request.requestId!==row.command_id||Object.entries(expected(row)).some(([key,value])=>p[key]!==value)))fail('idempotency_conflict');
  if(row&&name==='rotate'&&['processing','interrupted'].includes(row.state))fail('outcome_unknown');
  if(row?.state==='active'||running.has(id)&&name==='status')return {requestId:request.requestId,data:view(request,base,row),replayed:false};
  if(running.has(id)||running.size>=2)fail('oauth_flow_busy');if(closed)fail('connection_blocked');
  const controller=new AbortController(),signal=controller.signal,timer=setTimeout(()=>controller.abort(),25000);timer.unref?.();running.set(id,controller);
  const principalPin=C.hash(JSON.stringify([principal.id,principal.keyId,principal.publicKey])),basePin=C.fingerprint(base);
  const event=(action,result,reason)=>eventFor(request,principal,policy,action,result,reason,now());
  function log(action,result,reason){if(store.backlog().pending>=policy.maxBacklog)fail('audit_unavailable');store.appendAudit(event(action,result,reason));}
  function check(){
   if(closed||signal.aborted)fail('provider_timeout');const key=policy.principals.find(v=>v.id===principal.id),currentBase=policy.connections.find(v=>v.connectionRef===base.connectionRef);
   if(!key?.enabled||C.hash(JSON.stringify([key.id,key.keyId,key.publicKey]))!==principalPin||C.fingerprint(currentBase)!==basePin)fail('scope_denied');
   require('./auth').authorize(key,request,policy);store.connection(base.connectionRef,now());store.assertAssetActive(request);row=owned(request,get(id));if(!row)fail('scope_denied');
   const v=authority(request,base,row);epochs.expected(v.credential,expected(row));return v;
  }
  async function validateToken(binding,borrowed,metadata){
   const v=check();B.metadata(metadata,binding);
   if(B.identityKeys(v.credential.metadata).some(k=>metadata[k]!==v.credential.metadata[k]))fail('oauth_identity_mismatch');
   const actualExpiry=m=>Math.min(...[m.expiresAt,m.dataAccessExpiresAt].filter(v=>v!==null));
   if(metadata.expiresAt<=v.credential.metadata.expiresAt||actualExpiry(metadata)<=actualExpiry(v.credential.metadata))fail('oauth_credentials_incomplete');
   enrollment.assertRenewalCredential(row.enrollment,binding,metadata);
   const assets=await http.discover({binding,...borrowed,metadata,signal,authorize:check});D.checkAssets(assets,metadata);
   const selected=E.assets(v.assets.map(a=>{const found=assets.find(d=>d.assetRef===a.assetRef);if(!found)fail('scope_denied');return E.identity(found);}));
   if(JSON.stringify(selected)!==JSON.stringify(E.assets(v.assets)))fail('scope_denied');check();return v;
  }
  async function reconcileOrMint(fetchOnly){
   const v=check(),binding=v.binding,flow=epochs.flowFor(id);
   if(['staging','staged'].includes(flow?.state)&&flow.secret_digest){
    try{
     const found=await secrets.candidate(binding,flow,flow.secret_digest,signal);check();
     if(found.versionId!==id||found.digest!==flow.secret_digest||JSON.stringify(found.metadata)!==flow.credential_metadata)fail('secret_unavailable');
     store.transaction(()=>{check();store.db.prepare("UPDATE meta_marketing_oauth_flows SET state='staged',updated_at=? WHERE id=?").run(now(),id);store.db.prepare("UPDATE meta_marketing_credential_maintenance SET state='staged',candidate_digest=?,candidate_metadata=?,updated_at=? WHERE id=?").run(flow.secret_digest,flow.credential_metadata,now(),id);});return;
    }catch(error){if(!fetchOnly)throw error;}
   }
   await secrets.withCandidate(binding,v.credential.flow,v.credential.digest,async old=>{
    check();return businessHttp.withManagedToken({binding,current:v.credential.metadata,token:old.token,appSecret:old.appSecret,assets:v.assets,fetchOnly,signal,authorize:check,beforeManage:()=>store.transaction(()=>{check();store.db.prepare('UPDATE meta_marketing_credential_maintenance SET provider_intent_at=?,not_applied_at=NULL,retry_observed_at=NULL,updated_at=? WHERE id=?').run(now(),now(),id);})},async(token,metadata)=>{
     await validateToken(binding,{token,appSecret:old.appSecret},metadata);let encoded;
     try{
      const pending=epochs.flowFor(id);encoded=secrets.encode(binding,pending,metadata,token);
      if(pending.secret_digest&&pending.secret_digest!==encoded.digest)fail('secret_unavailable');
      store.transaction(()=>{check();store.db.prepare("UPDATE meta_marketing_oauth_flows SET state='staging',secret_digest=?,credential_metadata=?,updated_at=? WHERE id=?").run(encoded.digest,JSON.stringify(metadata),now(),id);});
      await secrets.stage(binding,epochs.flowFor(id),encoded,signal);check();
      store.transaction(()=>{check();store.db.prepare("UPDATE meta_marketing_oauth_flows SET state='staged',updated_at=? WHERE id=?").run(now(),id);store.db.prepare("UPDATE meta_marketing_credential_maintenance SET state='staged',candidate_digest=?,candidate_metadata=?,updated_at=? WHERE id=?").run(encoded.digest,JSON.stringify(metadata),now(),id);log('integration.completed','success','meta_credential_maintenance_staged');});
      return {versionId:id,digest:encoded.digest};
     }finally{encoded?.body.fill(0);}
    });
   },signal,{retentionStage:v.credential.retentionStage});
  }
  async function commit(){
   const v=check(),binding=v.binding,flow=epochs.flowFor(id);if(row.state!=='staged'||flow?.state!=='staged'||flow.secret_digest!==row.candidate_digest)fail('secret_unavailable');
   await secrets.withCandidate(binding,flow,flow.secret_digest,async borrowed=>{await validateToken(binding,borrowed,borrowed.metadata);return {verified:true};},signal,{requirePending:true});
   await epochs.protect(v.row,binding,{flow,versionId:id,digest:flow.secret_digest,metadata:JSON.parse(flow.credential_metadata)},secrets,signal);check();
   const completed={requestId:row.command_id,data:null,replayed:false},commandId=row.command_id;
   store.complete(roles.control,commandId,completed,event('integration.completed','success','meta_credential_maintenance_activated'),{mutate:()=>{
    const current=check(),next=current.credential.epoch+1;
    if(current.credential.epoch===0)store.db.prepare('INSERT INTO meta_marketing_effective_credentials VALUES (?,?,?,?,?,?,?)').run(row.enrollment,next,id,row.candidate_digest,row.candidate_metadata,id,now());
    else if(store.db.prepare('UPDATE meta_marketing_effective_credentials SET epoch=?,version=?,digest=?,metadata=?,renewal=?,switched_at=? WHERE enrollment=? AND epoch=? AND version=? AND digest=?').run(next,id,row.candidate_digest,row.candidate_metadata,id,now(),row.enrollment,row.expected_epoch,row.expected_version,row.expected_digest).changes!==1)fail('secret_version_changed');
    store.db.prepare("UPDATE meta_marketing_credential_maintenance SET state='active',last_error=NULL,updated_at=? WHERE id=?").run(now(),id);row=get(id);completed.data=view(request,base,row);
   }});
  }
  try{
   if(name==='rotate'&&!row){
    if(!config||!B.selected(base,config).enabled)fail('operation_denied');const v=enrollment.renewalAuthority(p.enrollmentId,base);if(!K.business(v.binding))fail('operation_denied');epochs.expected(v.credential,p);
    const commandDigest=C.hash(canonical({operation:request.operation,tenantRef:request.tenantRef,connectionRef:request.connectionRef,assetRef:request.assetRef,payload:p}));
    store.transaction(()=>{
     if(get(id)||epochs.flowFor(id)||store.db.prepare("SELECT 1 FROM meta_marketing_credential_maintenance WHERE enrollment=? AND state IN ('processing','not_applied','staged','interrupted')").get(v.row.id))fail('oauth_flow_busy');
     log('integration.requested','accepted','meta_credential_maintenance_requested');
     store.db.prepare("INSERT INTO meta_marketing_credential_maintenance(id,enrollment,principal,tenant,connection,scope,expected_epoch,expected_version,expected_digest,grant_digest,asset_digest,state,created_at,updated_at,command_id,command_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,'processing',?,?,?,?)").run(id,v.row.id,roles.control,request.tenantRef,request.connectionRef,request.assetRef,p.expectedEpoch,p.expectedVersionId,p.expectedCandidateDigest,epochs.grantDigest(v.row),R.assetSetDigest(v.assets),now(),now(),request.requestId,commandDigest);
    });row=get(id);store.transaction(()=>{check();store.db.prepare("INSERT INTO meta_marketing_oauth_flows(id,principal,tenant,connection,asset,state_hash,config_digest,scope_digest,clinic_digest,created_at,expires_at,updated_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'exchanging')").run(id,roles.gateway,row.tenant,row.connection,row.scope,C.hash('maintenance:'+id),K.fingerprint(v.binding),v.row.scope_digest,epochs.flowFor(v.row.flow).clinic_digest,now(),enrollment.providerLifecycleAuthority(base.connectionRef,base,v.row.id)?now()+600000:Math.min(now()+600000,base.expiresAt),now());});check();await secrets.retentionCapacity(v.binding,v.credential.retentionStage?1:2,signal);await epochs.protect(v.row,v.binding,v.credential,secrets,signal);check();
    store.reserve(principal.id,request.requestId,commandDigest,event('integration.requested','accepted','meta_credential_maintenance_requested'),policy.maxBacklog,now());
    await reconcileOrMint(false);
   }else{
    check();
    if(name==='status'&&row.state==='interrupted'&&(!row.provider_intent_at||Number.isSafeInteger(row.not_applied_at))){const pending=epochs.flowFor(id);if(pending?.secret_digest||!pending||pending.state!=='exchanging')fail('outcome_unknown');store.db.prepare("UPDATE meta_marketing_credential_maintenance SET state='not_applied',retry_observed_at=?,updated_at=? WHERE id=?").run(now(),now(),id);row=get(id);return {requestId:request.requestId,data:view(request,base,row),replayed:false};}
    if(row.state==='not_applied'){
     if(name==='status')return {requestId:request.requestId,data:view(request,base,row),replayed:false};
     if(request.requestId!==row.command_id||p.enrollmentId!==row.enrollment||Object.entries(expected(row)).some(([key,value])=>p[key]!==value)||!Number.isSafeInteger(row.retry_observed_at))fail('idempotency_conflict');
     store.db.prepare("UPDATE meta_marketing_credential_maintenance SET state='processing',provider_intent_at=NULL,not_applied_at=NULL,retry_observed_at=NULL,last_error=NULL,updated_at=? WHERE id=?").run(now(),id);row=get(id);const retry=check();await secrets.retentionCapacity(retry.binding,retry.credential.retentionStage?1:2,signal);await epochs.protect(retry.row,retry.binding,retry.credential,secrets,signal);if(!store.db.prepare('SELECT 1 FROM commands WHERE principal=? AND id=?').get(principal.id,request.requestId))store.reserve(principal.id,request.requestId,row.command_digest,event('integration.requested','accepted','meta_credential_maintenance_requested'),policy.maxBacklog,now());await reconcileOrMint(false);
    }
    if(row.state==='rejected')return {requestId:request.requestId,data:view(request,base,row),replayed:false};
    // A repeated rotation never mints again. Recovery uses the documented
    // fetch_only=true operation and validates exact existing grant/expiry.
    row=get(id);if(row.state!=='staged'){if(!row.provider_intent_at)fail('outcome_unknown');await reconcileOrMint(true);}
   }
   row=get(id);if(row.state==='staged')await commit();row=get(id);return {requestId:request.requestId,data:view(request,base,row),replayed:false};
  }catch(error){
   const safe=require('./meta-marketing-graph-pacing').safeError(error,'internal_error');
   if(row&&row.state!=='active')store.transaction(()=>{const current=get(id);if(current?.state!=='active'){
    const state=['oauth_identity_mismatch','oauth_credentials_incomplete','scope_denied','credential_revoked','provider_unauthorized'].includes(safe.code)?'rejected':'interrupted';
    store.db.prepare('UPDATE meta_marketing_credential_maintenance SET state=?,last_error=?,not_applied_at=?,updated_at=? WHERE id=?').run(state,safe.code,error.knownNotApplied===true?now():null,now(),id);
    log('integration.completed',state==='rejected'?'denied':'unknown','meta_credential_maintenance_'+state);
   }});throw safe;
  }finally{clearTimeout(timer);running.delete(id);}
 }
 return {operations:Object.fromEntries(Object.entries(T.OPERATIONS).map(([name,operation])=>[operation,{provider:C.PROVIDER,control:'meta_marketing_oauth',validate:T.validators[name],execute}])),close(){closed=true;for(const c of running.values())c.abort();}};
}
module.exports={createMetaMarketingCredentialMaintenance};
