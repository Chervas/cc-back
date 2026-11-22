'use strict';
const {randomUUID}=require('node:crypto'),C=require('./metaMarketingEnrollment.contract'),F=require('./metaMarketingEffectiveCredential.service');
const V=require('../../services/integrations-broker/src/meta-marketing-enrollment-assets-contract');
const {fromActiveInventory}=require('../../services/platform-audit/src/meta-active-inventory-event');
const plain=row=>row?.get?row.get({plain:true}):row;
function createActiveInventory({models,sessions,client,now=()=>new Date(),enabled=()=>process.env.META_MARKETING_ENROLLMENT_ENABLED==='true'&&process.env.META_MARKETING_OAUTH_DISCOVERY_ENABLED==='true',audit:providedAudit}={}){
 const scope=require('./metaMarketingOAuthScope.service').createScope({models,sessions,now});
 const order=require('./metaMarketingTransactionOrder.service').createOrder({models,authorize:scope.authorize,unavailable:()=>C.fail('meta_enrollment_unavailable',503)});
 const bindings=require('./metaMarketingEnrollmentBinding.service').createBindings({models,sessions,now}),credentials=F.createEffectiveCredentials({models,now});
 const audit=providedAudit||require('./platformAudit.repository').createRepository(models.PlatformAuditEvent);
 const gate=()=>{if(!enabled())C.fail('meta_enrollment_disabled',503);};
 async function capture(input,id,transaction,includeAvatars=false){
  await scope.authorize(input,transaction);
  const raw=await models.MetaMarketingEnrollmentRequest.findByPk(id,{transaction,lock:transaction.LOCK.UPDATE,logging:false});
  if(!raw||raw.scope_key!==input.scopeKey)C.fail('meta_enrollment_scope_forbidden',403);
  const row=C.request(plain(raw));if(row.state!=='active')C.fail('meta_enrollment_not_active',409);
  const authority=await bindings.committed(id,transaction);
  const flow=await models.MetaMarketingOAuthRequest.findByPk(row.flow_id,{transaction,lock:transaction.LOCK.UPDATE,logging:false});
  const effective=await credentials.resolve(row,flow,transaction);
  return {row,effective,authorityDigest:authority.digest,payload:{enrollmentId:id,scopeDigest:row.scope_digest,selectionDigest:row.selection_digest,
   clinicSetDigest:C.hash(row.clinic_ids),assetSetDigest:F.assetSetDigest(row.selected),expectedEpoch:effective.epoch,expectedVersionId:effective.versionId,
   expectedCandidateDigest:effective.digest,...(includeAvatars?{includeAvatars:true}:{})}};
 }
 async function record(value,input,id,reason,transaction,result=null){
  const health=await audit.health(now(),{includeUnresolved:false,transaction});
  if(!Number.isSafeInteger(health.pending)||health.pending>=9999||!Number.isFinite(health.oldestAgeSeconds)||health.oldestAgeSeconds>=3600)C.fail('audit_unavailable',503);
  await audit.append(fromActiveInventory(value,input,id,reason,now(),result),{transaction});
 }
 function validate(value,captured,startedAt){
  const {row,effective,payload}=captured;
  try{return V.validateResult(value,{enrollmentId:row.enrollment_id,scopeKey:row.scope_key,...payload,epoch:effective.epoch,versionId:effective.versionId,digest:effective.digest,
   metadata:effective.metadata,selected:row.selected,startedAt,now:+now()});}catch{C.fail('broker_response_invalid',503);}
 }
 async function describe(input,row,transaction){
  if(row.state!=='active'||!enabled())return null;
  const value=await capture(input,row.enrollment_id,transaction);
  return {mode:'active',enrollmentId:row.enrollment_id,epoch:value.effective.epoch,versionId:value.effective.versionId};
 }
 async function assets(input,id,includeAvatars=false){
  gate();if(!C.UUID.test(id))C.fail('meta_enrollment_invalid',400);
  input=require('./metaMarketingTransactionOrder.service').pinInput(input);const requestId=randomUUID(),startedAt=+now();let captured;
  const authorized=work=>order.enrollment(input,id,async({transaction,enrollment})=>{
   gate();if(!enrollment)C.fail('meta_enrollment_scope_forbidden',403);
   const fresh=await capture(input,id,transaction,includeAvatars);
   if(captured&&(fresh.authorityDigest!==captured.authorityDigest||JSON.stringify(fresh.payload)!==JSON.stringify(captured.payload)))C.fail('meta_enrollment_scope_changed',409);
   return work?work(fresh,transaction):fresh;
  });
  try{
   captured=await authorized(async(value,transaction)=>{await record(value,input,requestId,'inventory_requested',transaction);return value;});
   await authorized();
   const response=await client.execute({requestId,operation:C.E.OPERATIONS.assets,tenantRef:'clinic:'+captured.row.clinicIds[0],connectionRef:captured.row.connection_ref,
    assetRef:'meta-enroll:'+captured.row.scope_key,payload:captured.payload},{timeoutMs:30000});
   if(!C.exact(response,'requestId,data,replayed')||response.requestId!==requestId||response.replayed!==false)C.fail('broker_response_invalid',503);
   const inventory=validate(response.data,captured,startedAt);
   return await authorized(async(value,transaction)=>{if(inventory.expiresAt<=+now())C.fail('broker_response_invalid',503);
    // Health may shorten a deadline without changing epoch/version. The result
    // must remain inside the current bounds as well as the captured ones.
    if([value.effective.metadata.expiresAt,value.effective.metadata.dataAccessExpiresAt].some(limit=>limit!==null&&inventory.expiresAt>limit))C.fail('meta_enrollment_scope_changed',409);
    validate(inventory,value,startedAt);
    await record(value,input,requestId,'inventory_verified',transaction,inventory);return {mode:'active',inventory};});
  }catch(error){
   if(captured)try{await models.sequelize.transaction(transaction=>record(captured,input,requestId,[401,403,409].includes(error.httpStatus)?'access_changed':'inventory_unavailable',transaction));}catch{}
   throw error;
  }
 }
 return {describe,assets};
}
module.exports={createActiveInventory};
