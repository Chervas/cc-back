'use strict';
const {randomUUID}=require('node:crypto'),C=require('./metaMarketingEnrollment.contract'),F=require('./metaMarketingEffectiveCredential.service');
const {Op}=require('sequelize');
const V=require('../../services/integrations-broker/src/meta-marketing-enrollment-assets-contract');
const {assetAvatarUrl}=require('../../services/integrations-broker/src/meta-marketing-discovery-contract');
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
 const displayWhere=row=>{
  const scope=bindings.scopeOf(row);
  return {metaConnectionId:Number(row.meta_connection_id),assignmentScope:scope.assignmentScope,
   clinicaId:scope.clinicId,grupoClinicaId:scope.groupId,isActive:true};
 };
 const displayName=(name,id)=>typeof name==='string'&&name.trim()&&name.length<=255&&name.trim().replace(/^act_/,'')!==id
  &&!/[\x00-\x1f\x7f]/.test(name)?name.trim():undefined;
 const displayAvatar=url=>typeof url==='string'&&url.length<=512?assetAvatarUrl(url):undefined;
 async function displayMappings(row,transaction){
  // The caller already holds the exact committed enrollment and mapping locks.
  const rows=await models.ClinicMetaAsset.findAll({attributes:['id','assetType','metaAssetId','metaAssetName','assetAvatarUrl','updatedAt'],
   where:{...displayWhere(row),id:{[Op.in]:row.mappingIds}},order:[['id','ASC']],raw:true,logging:false,transaction,lock:transaction.LOCK.UPDATE});
  if(rows.length!==row.mappingIds.length||rows.some((mapping,index)=>Number(mapping.id)!==row.mappingIds[index]))C.fail('meta_enrollment_scope_changed',409);
  const selected=new Set(row.selected.map(asset=>asset.assetRef));
  const result=rows.map(mapping=>{
   const id=mapping.assetType==='ad_account'?String(mapping.metaAssetId).replace(/^act_/,''):String(mapping.metaAssetId);
   const assetRef='meta-'+mapping.assetType+':'+id;
   if(!selected.delete(assetRef))C.fail('meta_enrollment_scope_changed',409);
   return {...mapping,id,assetRef,mappingId:Number(mapping.id)};
  });
  if(selected.size)C.fail('meta_enrollment_scope_changed',409);
  return result;
 }
 async function storeDisplay(row,inventory,transaction){
  const assets=new Map(inventory.assets.map(asset=>[asset.assetRef,asset]));
  for(const mapping of await displayMappings(row,transaction)){
   // A read that took longer to finish cannot replace a more recent observation.
   if(mapping.updatedAt instanceof Date&&+mapping.updatedAt>inventory.observedAt)continue;
   const asset=assets.get(mapping.assetRef);
   const name=displayName(asset.name,mapping.id),avatar=displayAvatar(asset.avatarUrl);
   const patch={...(name&&name!==mapping.metaAssetName?{metaAssetName:name}:{}),
    ...(avatar&&avatar!==mapping.assetAvatarUrl?{assetAvatarUrl:avatar}:{})};
   if(!Object.keys(patch).length)continue;
   const [changed]=await models.ClinicMetaAsset.update(patch,{fields:Object.keys(patch),where:{...displayWhere(row),
    id:mapping.mappingId,assetType:mapping.assetType,metaAssetId:mapping.metaAssetId},transaction,logging:false});
   if(changed!==1)C.fail('meta_enrollment_scope_changed',409);
  }
 }
 async function describe(input,row,transaction){
  if(row.state!=='active'||!enabled())return null;
  const value=await capture(input,row.enrollment_id,transaction);
  const displayAssets=(await displayMappings(value.row,transaction)).flatMap(mapping=>{
   const name=displayName(mapping.metaAssetName,mapping.id);
   const avatarUrl=mapping.assetType==='ad_account'?undefined:displayAvatar(mapping.assetAvatarUrl);
   return name||avatarUrl?[{assetRef:mapping.assetRef,...(name?{name}:{}),...(avatarUrl?{avatarUrl}:{})}]:[];
  });
  return {mode:'active',enrollmentId:row.enrollment_id,epoch:value.effective.epoch,versionId:value.effective.versionId,
   ...(displayAssets.length?{displayAssets}:{})};
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
    await record(value,input,requestId,'inventory_verified',transaction,inventory);
    await storeDisplay(value.row,inventory,transaction);
    return {mode:'active',inventory};});
  }catch(error){
   if(captured)try{await models.sequelize.transaction(transaction=>record(captured,input,requestId,[401,403,409].includes(error.httpStatus)?'access_changed':'inventory_unavailable',transaction));}catch{}
   throw error;
  }
 }
 return {describe,assets};
}
module.exports={createActiveInventory};
