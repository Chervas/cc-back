'use strict';
const {fail}=require('./errors'),{eventFor}=require('./audit'),{canonical}=require('./canonical');
const C=require('./meta-marketing-oauth-contract'),K=require('./meta-marketing-credential-shape'),B=require('./meta-marketing-business-contract'),I=require('./meta-marketing-business-issuer');
const E=require('./meta-marketing-enrollment-contract'),D=require('./meta-marketing-discovery-contract'),R=require('./meta-marketing-credential-renewal-contract');
function createMetaMarketingBusiness({store,epochs,enrollment,oauth,secrets,http,environment,config,now=Date.now}){
 I.config(config);const roles=E.roles(environment),running=new Map();let closed=false;
 store.db.exec(`CREATE TABLE IF NOT EXISTS meta_marketing_business_handovers(
  id TEXT PRIMARY KEY,old_enrollment TEXT NOT NULL,principal TEXT NOT NULL,tenant TEXT NOT NULL,connection TEXT NOT NULL,scope TEXT NOT NULL,
  expected_epoch INTEGER NOT NULL,expected_version TEXT NOT NULL,expected_digest TEXT NOT NULL,old_grant_digest TEXT NOT NULL,asset_digest TEXT NOT NULL,
  old_scope_digest TEXT NOT NULL,scope_digest TEXT NOT NULL,clinic_digest TEXT NOT NULL,state_hash TEXT NOT NULL UNIQUE,
  config_digest TEXT NOT NULL,assets TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
  state TEXT NOT NULL,candidate_digest TEXT,candidate_metadata TEXT,drain_digest TEXT,activation_request TEXT,activation_reconciled_at INTEGER,old_claims TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS meta_marketing_business_pending ON meta_marketing_business_handovers(old_enrollment) WHERE state IN ('awaiting','processing','staged','interrupted');`);
 const get=id=>store.db.prepare('SELECT * FROM meta_marketing_business_handovers WHERE id=?').get(id);
 function owned(request,row){if(row&&(row.tenant!==request.tenantRef||row.connection!==request.connectionRef||row.scope!==request.assetRef||row.principal!==roles.gateway))fail('scope_denied');return row;}
 const pins=row=>({expectedEpoch:row.expected_epoch,expectedVersionId:row.expected_version,expectedCandidateDigest:row.expected_digest});
 function original(request,base,row){
  const v=enrollment.renewalAuthority(row.old_enrollment,base);
  if(v.row.tenant!==request.tenantRef||v.row.connection!==request.connectionRef||v.row.scope!==request.assetRef||epochs.grantDigest(v.row)!==row.old_grant_digest
   ||R.assetSetDigest(v.assets)!==row.asset_digest||v.row.scope_digest!==row.old_scope_digest)fail('scope_denied');
  const claims=store.db.prepare('SELECT asset,enrollment FROM meta_marketing_enrollment_claims WHERE enrollment=? ORDER BY asset').all(v.row.id);if(JSON.stringify(claims)!==row.old_claims)fail('scope_denied');
  epochs.expected(v.credential,pins(row));return v;
 }
 function drain(row){const value=store.db.prepare("SELECT * FROM meta_marketing_business_barriers WHERE enrollment=? AND handover=? AND state='closed'").get(row.old_enrollment,row.id);
  return value?{closed:true,receiptRefs:JSON.parse(value.receipt_refs),receiptSetDigest:value.receipt_digest,activeOperations:enrollment.activeOperations(row.old_enrollment)}:null;}
 function view(request,base,row){
  if(!row)return {handoverId:request.payload.handoverId,flowId:request.payload.handoverId,newEnrollmentId:null,oldEnrollmentId:null,status:'not_found',oldGrantDigest:null,assetSetDigest:null,candidate:null,newEnrollment:null,handoverApplied:false,drain:null};
  owned(request,row);return {handoverId:row.id,flowId:row.id,newEnrollmentId:row.id,oldEnrollmentId:row.old_enrollment,status:row.state,
   oldGrantDigest:row.old_grant_digest,assetSetDigest:row.asset_digest,candidate:['staged','active'].includes(row.state)?{versionId:row.id,digest:row.candidate_digest,metadata:JSON.parse(row.candidate_metadata)}:null,
   newEnrollment:row.state==='active'?enrollment.receiptForEnrollment(row.id,base):null,handoverApplied:row.state==='active',drain:drain(row)};
 }
 async function execute({request,principal,binding:base,policy}){
  const existingRow=get(request.payload.handoverId),binding=existingRow?I.pinned(base,config,existingRow.config_digest,JSON.parse(existingRow.assets)):I.derive(base,config),modeConfig=I.bindingFor(binding).businessLogin,name=B.validate(request.operation,request.payload),p=request.payload,id=p.handoverId;I.authorize({request,principal,binding},environment);
  let row=owned(request,get(id));if(closed)fail('connection_blocked');
  if(name==='status'&&!row)return {requestId:request.requestId,data:view(request,base,null),replayed:false};
  if(name!=='begin'&&!row)fail('scope_denied');
  if(name==='status'&&running.has(id)||row?.state==='active'&&['status','activate','abort'].includes(name))return {requestId:request.requestId,data:view(request,base,row),replayed:false};
  if(name!=='abort'&&(running.has(id)||running.size>=2))fail('oauth_flow_busy');
  const agencyFinish=name==='finish'&&require('./meta-marketing-agency-contract').isBinding(binding);let background=false;
  const controller=new AbortController(),signal=controller.signal,timer=setTimeout(()=>controller.abort(),agencyFinish?120000:25000);timer.unref?.();
  if(name!=='abort')running.set(id,controller);
  const authPin=C.hash(JSON.stringify([principal.id,principal.keyId,principal.publicKey])),configPin=K.fingerprint(binding);
  const event=(action,result,reason)=>eventFor(request,principal,policy,action,result,reason,now());
  function log(action,result,reason){if(store.backlog().pending>=policy.maxBacklog)fail('audit_unavailable');store.appendAudit(event(action,result,reason));}
  function check({terminal=false,old=true}={}){
   if(signal.aborted||closed)fail('provider_timeout');const current=policy.principals.find(v=>v.id===principal.id);
   if(!current?.enabled||C.hash(JSON.stringify([current.id,current.keyId,current.publicKey]))!==authPin)fail('scope_denied');
   require('./auth').authorize(current,request,policy);const currentBase=policy.connections.find(v=>v.connectionRef===base.connectionRef);
   if(K.fingerprint(I.pinned(currentBase,config,configPin))!==configPin)fail('scope_denied');
   store.connection(base.connectionRef,now());store.assertAssetActive(request);row=owned(request,get(id));
   if(!row||row.config_digest!==configPin||!terminal&&['active','aborted','rejected'].includes(row.state))fail('oauth_flow_interrupted');
   return old?original(request,base,row):null;
  }
  const retained=()=>{const v=check(),ids=new Set(),seen=new Set();let current=v.row.id;for(let n=0;n<16;n++){if(seen.has(current))fail('scope_denied');seen.add(current);const e=store.db.prepare('SELECT flow FROM meta_marketing_enrollments WHERE id=?').get(current);if(!e)fail('scope_denied');ids.add(e.flow);for(const f of store.db.prepare("SELECT id FROM meta_marketing_credential_renewals WHERE enrollment=? AND state='active'").all(current))ids.add(f.id);if(store.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='meta_marketing_credential_maintenance'").get())for(const f of store.db.prepare('SELECT id FROM meta_marketing_credential_maintenance WHERE enrollment=?').all(current))ids.add(f.id);const parent=store.db.prepare('SELECT old_enrollment FROM meta_marketing_enrollment_successions WHERE new_enrollment=?').get(current);if(!parent)return [...ids];current=parent.old_enrollment;}fail('scope_denied');};
  const callOAuth=(family,payload)=>oauth.executeRenewal({request:{...request,requestId:family==='begin'?id:request.requestId,operation:C.OPERATIONS[family],payload},principal,binding,policy},
   {guard:()=>check({terminal:family==='abort',old:family!=='abort'}),retainedFlowIds:retained,providerLifecycle:()=>enrollment.providerLifecycleAuthority(base.connectionRef,base,row.old_enrollment),signal});
  function stage(value){return store.transaction(()=>{check();const flow=epochs.flowFor(id);if(flow?.state!=='staged'||!flow.secret_digest)fail('oauth_flow_interrupted');
   const metadata=I.metadata(value,binding);log('integration.completed','success','meta_business_handover_staged');
   store.db.prepare("UPDATE meta_marketing_business_handovers SET state='staged',candidate_digest=?,candidate_metadata=?,updated_at=? WHERE id=?").run(flow.secret_digest,JSON.stringify(metadata),now(),id);row=get(id);});}
  function receiptRefs(enrollmentId){return store.db.prepare('SELECT id FROM meta_marketing_lead_receipts WHERE enrollment=? UNION SELECT receipt AS id FROM meta_marketing_business_receipt_lineage WHERE new_enrollment=? ORDER BY id LIMIT 1001').all(enrollmentId,enrollmentId).map(v=>v.id);}
  async function verify(){
   const v=check(),flow=epochs.flowFor(id);if(flow?.state!=='staged'||row.candidate_digest&&flow.secret_digest!==row.candidate_digest)fail('secret_unavailable');
   return secrets.withCandidate(binding,flow,flow.secret_digest,async borrowed=>{
    check();I.metadata(borrowed.metadata,binding);if(v.credential.metadata.tokenType==='USER'&&borrowed.metadata.subjectId===v.credential.metadata.subjectId||v.credential.metadata.tokenType==='SYSTEM_USER'&&I.identityKeys(v.credential.metadata).some(key=>borrowed.metadata[key]!==v.credential.metadata[key]))fail('oauth_identity_mismatch');enrollment.assertRenewalCredential(row.old_enrollment,base,borrowed.metadata);
    if(require('./meta-marketing-agency-contract').isBinding(binding)){if(typeof http.verifyBusiness!=='function')fail('operation_denied');await http.verifyBusiness({binding,...borrowed,assets:v.assets,signal,authorize:check});}
    const inventory=await http.discover({binding,...borrowed,signal,authorize:check});D.checkAssets(inventory,borrowed.metadata);
    const assets=E.assets(v.assets.map(a=>{const found=inventory.find(d=>d.assetRef===a.assetRef);if(!found)fail('scope_denied');return E.identity(found);}));
    if(JSON.stringify(assets)!==row.assets)fail('scope_denied');check();return {assets,metadata:borrowed.metadata};
   },signal,{requirePending:true});
  }
  try{
   if(name==='begin'){
    if(!modeConfig.enabled)fail('operation_denied');const v=enrollment.renewalAuthority(p.oldEnrollmentId,base),b=C.bindingFor(base);epochs.expected(v.credential,p);
    if(v.row.tenant!==request.tenantRef||v.row.connection!==request.connectionRef||v.row.scope!==request.assetRef||v.row.scope_digest!==p.oldScopeDigest
     ||R.assetSetDigest(v.assets)!==p.assetSetDigest||p.clinicSetDigest!==C.clinicDigest(b)||p.expiresAt<=now()||p.expiresAt>now()+600000||p.expiresAt>base.expiresAt&&!enrollment.providerLifecycleAuthority(base.connectionRef,base,p.oldEnrollmentId)
     ||v.assets.some(a=>!['ad_account','facebook_page'].includes(a.kind)))fail('scope_denied');
    const pin={old_enrollment:v.row.id,principal:roles.gateway,tenant:request.tenantRef,connection:request.connectionRef,scope:request.assetRef,expected_epoch:p.expectedEpoch,expected_version:p.expectedVersionId,expected_digest:p.expectedCandidateDigest,
     old_grant_digest:epochs.grantDigest(v.row),asset_digest:p.assetSetDigest,old_scope_digest:p.oldScopeDigest,scope_digest:p.scopeDigest,clinic_digest:p.clinicSetDigest,state_hash:C.hash(p.state),config_digest:configPin,assets:JSON.stringify(E.assets(v.assets)),expires_at:p.expiresAt};
    store.transaction(()=>{
     const old=owned(request,get(id));if(old){if(Object.entries(pin).some(([key,value])=>old[key]!==value)||old.state!=='awaiting')fail('idempotency_conflict');}
     else{if(epochs.flowFor(id)||store.db.prepare("SELECT 1 FROM meta_marketing_business_handovers WHERE old_enrollment=? AND state IN ('awaiting','processing','staged','interrupted')").get(v.row.id))fail('oauth_flow_busy');
      log('integration.requested','accepted','meta_business_handover_requested');
      const keys=Object.keys(pin).filter(k=>k!=='expires_at'),claims=store.db.prepare('SELECT asset,enrollment FROM meta_marketing_enrollment_claims WHERE enrollment=? ORDER BY asset').all(v.row.id);if(claims.length!==v.assets.length||claims.some(claim=>!v.assets.some(asset=>asset.assetRef===claim.asset)))fail('scope_denied');
      store.db.prepare(`INSERT INTO meta_marketing_business_handovers(id,${keys.join(',')},created_at,expires_at,updated_at,state,old_claims) VALUES (${new Array(keys.length+4).fill('?').join(',')},'awaiting',?)`).run(id,...keys.map(k=>pin[k]),now(),p.expiresAt,now(),JSON.stringify(claims));
     }
    });row=get(id);check();await secrets.retentionCapacity(base,v.credential.retentionStage?1:2,signal);await epochs.protect(v.row,v.binding||base,v.credential,secrets,signal);check();
    const response=await callOAuth('begin',{state:p.state,scopeDigest:p.scopeDigest,clinicSetDigest:p.clinicSetDigest,expiresAt:p.expiresAt});
    return {requestId:request.requestId,data:{handoverId:id,flowId:id,newEnrollmentId:id,oldEnrollmentId:row.old_enrollment,oldGrantDigest:row.old_grant_digest,authUrl:response.data.authUrl,expiresAt:p.expiresAt},replayed:false};
   }
   if(name==='abort'){
    const prior=running.get(id);prior?.abort();await callOAuth('abort',{flowId:id});
    store.transaction(()=>{check({terminal:true,old:false});if(row.state!=='active'){
     store.db.prepare("UPDATE meta_marketing_business_handovers SET state='aborted',updated_at=? WHERE id=?").run(now(),id);
     store.db.prepare("UPDATE meta_marketing_business_barriers SET state='aborted',updated_at=? WHERE enrollment=? AND handover=?").run(now(),row.old_enrollment,id);
     log('integration.completed','success','meta_business_handover_aborted');}});
   }else if(name==='finish'){
    if(!modeConfig.enabled)fail('operation_denied');check();store.db.prepare("UPDATE meta_marketing_business_handovers SET state='processing',updated_at=? WHERE id=? AND state='awaiting'").run(now(),id);
    const finish=async()=>{await callOAuth('finish',{flowId:id,state:p.state,code:p.code});const found=epochs.flowFor(id);if(found?.state!=='staged')fail('oauth_flow_interrupted');await verify();stage(JSON.parse(found.credential_metadata));};
    if(agencyFinish){background=true;Promise.resolve().then(finish).catch(async error=>{
      if(['oauth_identity_mismatch','oauth_credentials_incomplete','scope_denied','credential_revoked'].includes(error.code)){try{await callOAuth('abort',{flowId:id});}catch{}store.transaction(()=>{const live=get(id);if(live&&!['active','aborted'].includes(live.state)){store.db.prepare("UPDATE meta_marketing_business_handovers SET state='rejected',updated_at=? WHERE id=?").run(now(),id);log('integration.completed','denied','meta_business_handover_rejected');}});}
      else store.transaction(()=>{const live=get(id);if(live&&!['active','aborted','rejected'].includes(live.state)){store.db.prepare("UPDATE meta_marketing_business_handovers SET state='interrupted',updated_at=? WHERE id=?").run(now(),id);log('integration.completed','unknown','meta_business_handover_interrupted');}});
     }).catch(()=>{}).finally(()=>{clearTimeout(timer);running.delete(id);});
    }else await finish();
   }else if(name==='status'){
    check({terminal:true,old:!['aborted','rejected','active'].includes(row.state)});
    if(row.state==='staged'&&row.activation_request&&!running.has('activate:'+id)){const command=store.db.prepare('SELECT * FROM commands WHERE principal=? AND id=?').get(roles.gateway,row.activation_request);if(command&&command.state!=='completed'){check();store.db.prepare('UPDATE meta_marketing_business_handovers SET activation_reconciled_at=? WHERE id=?').run(now(),id);row=get(id);}}
    if(['processing','interrupted'].includes(row.state)){
     const status=await callOAuth('status',{flowId:id});
     if(status.data.status==='staged'){await verify();stage(JSON.parse(epochs.flowFor(id).credential_metadata));}
     else if(['interrupted','exchanging','aborted'].includes(status.data.status))store.db.prepare("UPDATE meta_marketing_business_handovers SET state='interrupted',updated_at=? WHERE id=?").run(now(),id);
    }
   }else if(name==='drain'){
    check();if(row.state!=='staged'||JSON.parse(row.candidate_metadata).expiresAt<=now())fail('oauth_credentials_incomplete');
    store.transaction(()=>{check();const receipts=receiptRefs(row.old_enrollment);
     if(receipts.length>1000)fail('rate_limited');const digest=B.drainDigest(id,row.old_grant_digest,receipts),old=drain(row);
     if(old&&(old.receiptSetDigest!==digest||JSON.stringify(old.receiptRefs)!==JSON.stringify(receipts)))fail('scope_denied');
     store.db.prepare("INSERT INTO meta_marketing_business_barriers VALUES (?,?,'closed',?,?,?) ON CONFLICT(enrollment) DO UPDATE SET handover=excluded.handover,state='closed',receipt_refs=excluded.receipt_refs,receipt_digest=excluded.receipt_digest,updated_at=excluded.updated_at").run(row.old_enrollment,id,JSON.stringify(receipts),digest,now());if(!old)log('integration.completed','success','meta_business_handover_drain_closed');
    });
   }else if(name==='activate'){
    if(!modeConfig.enabled)fail('operation_denied');const old=check();epochs.expected(old.credential,p);
    if(row.state!=='staged'||p.oldEnrollmentId!==row.old_enrollment||p.oldGrantDigest!==row.old_grant_digest||p.candidateDigest!==row.candidate_digest)fail('scope_denied');
    const drained=drain(row);if(!drained||drained.receiptSetDigest!==p.drainDigest||drained.activeOperations!==0)fail('scope_denied');
    const codeDigest=C.hash(canonical({operation:request.operation,payload:p,connectionRef:request.connectionRef})),existing=store.db.prepare('SELECT * FROM commands WHERE principal=? AND id=?').get(principal.id,request.requestId);
    if(row.activation_request&&row.activation_request!==request.requestId)fail('idempotency_conflict');
    if(existing){if(existing.digest!==codeDigest)fail('idempotency_conflict');if(!Number.isSafeInteger(row.activation_reconciled_at))fail('outcome_unknown');}
    store.transaction(()=>{check();store.db.prepare('UPDATE meta_marketing_business_handovers SET activation_request=?,activation_reconciled_at=NULL WHERE id=?').run(request.requestId,id);if(existing)store.db.prepare("UPDATE commands SET state='started' WHERE principal=? AND id=?").run(principal.id,request.requestId);});
    if(!existing)store.reserve(principal.id,request.requestId,codeDigest,event('integration.requested','accepted','meta_business_handover_activate_requested'),policy.maxBacklog,now());
    const candidate=await verify(),flow=epochs.flowFor(id),newCredential={flow,versionId:id,digest:flow.secret_digest,metadata:candidate.metadata};
    await epochs.protect({id},binding,newCredential,secrets,signal);check();
    const response={requestId:request.requestId,data:null,replayed:false};
    store.complete(principal.id,request.requestId,response,event('integration.completed','success','meta_business_handover_activated'),{mutate:()=>{
     check();const finalDrain=drain(row),actual=receiptRefs(row.old_enrollment);
     if(!finalDrain||finalDrain.receiptSetDigest!==p.drainDigest||finalDrain.activeOperations!==0||JSON.stringify(actual)!==JSON.stringify(finalDrain.receiptRefs))fail('scope_denied');
     enrollment.commitBusinessHandover({oldEnrollmentId:row.old_enrollment,newEnrollmentId:id,flow,binding,assets:candidate.assets,handoverId:id,receiptRefs:actual});
     store.db.prepare("UPDATE meta_marketing_business_handovers SET state='active',drain_digest=?,activation_request=?,updated_at=? WHERE id=?").run(p.drainDigest,request.requestId,now(),id);row=get(id);response.data=view(request,base,row);
    }});return response;
   }
   row=get(id);return {requestId:request.requestId,data:view(request,base,row),replayed:false};
  }catch(error){
   if(name==='finish'&&['oauth_identity_mismatch','oauth_credentials_incomplete','scope_denied','credential_revoked'].includes(error.code)){
    try{await callOAuth('abort',{flowId:id});}catch{}
    store.transaction(()=>{if(get(id)?.state!=='active'){store.db.prepare("UPDATE meta_marketing_business_handovers SET state='rejected',updated_at=? WHERE id=?").run(now(),id);log('integration.completed','denied','meta_business_handover_rejected');}});
   }
   throw require('./meta-marketing-graph-pacing').safeError(error,'internal_error');
  }finally{if(!background){clearTimeout(timer);if(name!=='abort')running.delete(id);}}
 }
 const operations=Object.fromEntries(Object.entries(B.OPERATIONS).map(([name,operation])=>[operation,{provider:C.PROVIDER,control:'meta_marketing_oauth',validate:B.validators[name],execute}]));
 return {operations,close(){closed=true;for(const c of running.values())c.abort();}};
}
module.exports={createMetaMarketingBusiness};
