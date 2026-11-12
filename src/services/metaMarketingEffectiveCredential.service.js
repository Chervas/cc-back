'use strict';
const C=require('./metaMarketingEnrollment.contract');
const plain=value=>value?.get?value.get({plain:true}):value;
const fail=(code='meta_credential_version_invalid',status=409)=>C.fail(code,status);
const assetSetDigest=selected=>C.hash(JSON.stringify(C.assets(selected).map(C.E.identity)));
const expiry=metadata=>{const values=[metadata.expiresAt,metadata.dataAccessExpiresAt].filter(value=>value!==null);return values.length?Math.min(...values):null;};
const split=candidate=>Object.fromEntries(Object.entries(candidate).filter(([key])=>!['versionId','digest'].includes(key)));
const PERMANENT=new Set(['credential_revoked','permissions_lost']);
const TEMPORARY=new Set(['provider_unauthorized','provider_timeout','provider_failed','broker_timeout','broker_unavailable','rate_limited','outcome_unknown','secret_unavailable','secret_version_changed']);
const health=(expired,code)=>expired?'expired':PERMANENT.has(code)?'permission_lost':TEMPORARY.has(code)?'temporary':'healthy';
function candidate(value,enrollment,scopes){
  if(enrollment.businessCredential){
    const checked=require('./metaMarketingBusiness.contract').candidate(value,{appId:enrollment.app_id,subjectId:enrollment.meta_user_id,...enrollment.businessCredential});
    if(JSON.stringify(checked.scopes)!==JSON.stringify(scopes))fail();return checked;
  }
  let checked;try{checked=C.candidate(value,{flow_id:value?.versionId,app_id:enrollment.app_id,scopes:JSON.stringify(scopes)});}catch{fail();}
  if(checked.subjectId!==enrollment.meta_user_id)fail();return checked;
}
function createEffectiveCredentials({models,now=()=>new Date()}){
  const options=transaction=>({raw:true,logging:false,...(transaction?{transaction,lock:transaction.LOCK.UPDATE}:{})});
  async function resolve(enrollmentInput,flowInput,transaction,{allowExpired=false}={}){
    let enrollment=plain(enrollmentInput),flow=plain(flowInput);let original;
    const business=await require('./metaMarketingBusinessSource.service').createSource({models,now}).forEnrollment(enrollment,transaction);
    if(business){flow=business.flow;original=business.candidate;enrollment={...enrollment,businessCredential:{...require('./metaMarketingBusiness.contract').pin(business.row),clientBusinessId:original.clientBusinessId,systemUserId:original.systemUserId}};}
    else try{original=C.candidate(JSON.parse(flow.candidate_metadata),flow);}catch{fail();}
    if(enrollment.state!=='active'||flow.flow_id!==enrollment.flow_id||original.digest!==enrollment.candidate_digest
      ||original.appId!==enrollment.app_id||original.subjectId!==enrollment.meta_user_id)fail();
    const pointer=models.MetaMarketingEffectiveCredential?plain(await models.MetaMarketingEffectiveCredential.findByPk(enrollment.enrollment_id,options(transaction))):null;
    let value={epoch:0,versionId:original.versionId,digest:original.digest,metadata:split(original),candidate:original,lastError:null};
    if(pointer&&Number(pointer.epoch)===0){
      if(pointer.enrollment_id!==enrollment.enrollment_id||pointer.renewal_id!==null||pointer.owner_receipt_digest!==null
        ||pointer.version_id!==original.versionId||pointer.candidate_digest!==original.digest||pointer.candidate_metadata!==JSON.stringify(original))fail();
      value.lastError=pointer.last_error;
    }else if(pointer){
      if(!models.MetaMarketingCredentialRenewal||pointer.enrollment_id!==enrollment.enrollment_id||!Number.isSafeInteger(Number(pointer.epoch))||Number(pointer.epoch)<1
        ||!C.UUID.test(pointer.renewal_id)||pointer.version_id!==pointer.renewal_id||!C.HASH.test(pointer.owner_receipt_digest))fail();
      let row=plain(await models.MetaMarketingCredentialRenewal.findByPk(pointer.renewal_id,options(transaction))),maintenance=false;
      if(!row&&business&&models.MetaMarketingCredentialMaintenance){row=plain(await models.MetaMarketingCredentialMaintenance.findByPk(pointer.renewal_id,options(transaction)));maintenance=true;}
      if(!row||row.state!==(maintenance?'succeeded':'active')||row.enrollment_id!==enrollment.enrollment_id||!maintenance&&(row.scope_key!==enrollment.scope_key||row.app_id!==enrollment.app_id
        ||row.meta_user_id!==enrollment.meta_user_id||row.clinic_ids!==enrollment.clinic_ids||row.assets!==enrollment.assets)
        ||Number(row.expected_epoch)+1!==Number(pointer.epoch)||row.candidate_metadata!==pointer.candidate_metadata
        ||typeof row.owner_receipt!=='string'||C.hash(row.owner_receipt)!==pointer.owner_receipt_digest)fail();
      let receipt,checked;try{receipt=JSON.parse(row.owner_receipt);checked=candidate(JSON.parse(pointer.candidate_metadata),enrollment,original.scopes);}catch{fail();}
      if(checked.versionId!==pointer.version_id||checked.digest!==pointer.candidate_digest||receipt.status!=='active'||receipt.activationApplied!==true
        ||(maintenance?receipt.maintenanceId!==row.maintenance_id:receipt.renewalId!==row.renewal_id)||receipt.enrollmentId!==enrollment.enrollment_id||receipt.effectiveCredential?.epoch!==Number(pointer.epoch)
        ||receipt.effectiveCredential.versionId!==checked.versionId||receipt.effectiveCredential.digest!==checked.digest
        ||JSON.stringify(receipt.effectiveCredential.metadata)!==JSON.stringify(split(checked)))fail();
      value={epoch:Number(pointer.epoch),versionId:checked.versionId,digest:checked.digest,metadata:split(checked),candidate:checked,lastError:pointer.last_error};
    }
    if(models.MetaMarketingCredentialMaintenance){
      const observed=plain(await models.MetaMarketingCredentialMaintenance.findOne({...options(transaction),where:{enrollment_id:enrollment.enrollment_id,expected_epoch:value.epoch,expected_version_id:value.versionId},order:[['requested_at','DESC']]}));
      if(observed?.health_metadata){
        let evidence;try{evidence=JSON.parse(observed.health_metadata);}catch{fail();}
        if(evidence.enrollmentId!==enrollment.enrollment_id||evidence.epoch!==value.epoch||evidence.versionId!==value.versionId||evidence.digest!==value.digest||!Number.isSafeInteger(evidence.verifiedAt))fail();
        if(typeof evidence.healthy!=='boolean'||(evidence.healthy?evidence.reason!==null:!['credential_revoked','permissions_lost','credential_expired'].includes(evidence.reason)))fail();
        // Every confirmed observation keeps its conservative deadline, including
        // a denial. A later health check cannot reopen an older finite bound.
        for(const key of ['expiresAt','dataAccessExpiresAt'])if(evidence[key]!==null){if(!Number.isSafeInteger(evidence[key])||evidence[key]<=0)fail();value.metadata[key]=value.metadata[key]===null?evidence[key]:Math.min(value.metadata[key],evidence[key]);}
      }
    }
    const expiresAt=expiry(value.metadata),expired=expiresAt!==null&&expiresAt<=+now();
    if(!allowExpired&&(expired||PERMANENT.has(value.lastError)))fail('meta_credential_renewal_required');
    return {...value,expired,requiresRenewal:expired||PERMANENT.has(value.lastError),healthKind:health(expired,value.lastError),
      observedAt:pointer?.last_error_at||pointer?.last_healthy_at||pointer?.activated_at||enrollment.activated_at,
      unknownSince:pointer?.unknown_since??null,lastHealthyAt:pointer?.last_healthy_at||pointer?.activated_at||enrollment.activated_at};
  }
  async function getCredentialStatus(enrollmentInput,{transaction}={}){
    const enrollment=plain(enrollmentInput),flow=await models.MetaMarketingOAuthRequest.findByPk(enrollment.flow_id,options(transaction));
    const value=await resolve(enrollment,flow,transaction,{allowExpired:true});
    return {enrollmentId:enrollment.enrollment_id,scopeKey:enrollment.scope_key,clinicIds:C.clinics(enrollment.clinic_ids),connectionId:Number(enrollment.meta_connection_id),
      appId:enrollment.app_id,subjectId:enrollment.meta_user_id,actorUserId:Number(enrollment.actor_user_id),epoch:value.epoch,versionId:value.versionId,
      expiresAt:value.metadata.expiresAt,dataAccessExpiresAt:value.metadata.dataAccessExpiresAt,expired:value.expired,requiresRenewal:value.requiresRenewal,
      tokenType:value.metadata.tokenType,clientBusinessId:value.metadata.clientBusinessId??null,configId:value.metadata.configId??null,
      issuerKind:value.metadata.tokenType==='USER'?'USER':require('./metaMarketingBusiness.contract').issuer(value.metadata),
      issuerBusinessId:value.metadata.issuerBusinessId??value.metadata.clientBusinessId??null,
      unknownSince:value.unknownSince===null?null:+new Date(value.unknownSince),lastHealthyAt:+new Date(value.lastHealthyAt),
      lastError:value.lastError,healthKind:value.healthKind,observedAt:new Date(value.observedAt).toISOString(),currentMetadata:{expiresAt:value.metadata.expiresAt,
        dataAccessExpiresAt:value.metadata.dataAccessExpiresAt,health:value.healthKind,lastError:value.lastError,observedAt:new Date(value.observedAt).toISOString()}};
  }
  async function updatePointer({enrollmentId,epoch,versionId,digest},patch,transaction){
    const [changed]=await models.MetaMarketingEffectiveCredential.update(patch,{where:{enrollment_id:enrollmentId,epoch,version_id:versionId,candidate_digest:digest},transaction,logging:false});
    if(changed===1)return true;if(changed!==0)return false;
    // MySQL may report zero changed rows for an idempotent repeated timestamp.
    // Recheck the complete current pin and patch under this same row lock; zero
    // is never treated as success merely because an UPDATE was attempted.
    const after=plain(await models.MetaMarketingEffectiveCredential.findByPk(enrollmentId,options(transaction)));
    return !!after&&after.enrollment_id===enrollmentId&&Number(after.epoch)===epoch&&after.version_id===versionId&&after.candidate_digest===digest
      &&Object.entries(patch).every(([key,value])=>value instanceof Date?after[key]!==null&&+new Date(after[key])===+value:after[key]===value);
  }
  async function recordFailure({enrollmentId,epoch,versionId},error,{transaction:providedTransaction}={}){
    const code=error?.code;if(!PERMANENT.has(code)&&!TEMPORARY.has(code)||!models.MetaMarketingEffectiveCredential)return false;
    const work=async transaction=>{
      const enrollment=plain(await models.MetaMarketingEnrollmentRequest.findByPk(enrollmentId,options(transaction)));
      if(!enrollment||enrollment.state!=='active')return false;
      const flow=await models.MetaMarketingOAuthRequest.findByPk(enrollment.flow_id,options(transaction)),value=await resolve(enrollment,flow,transaction,{allowExpired:true});
      if(value.epoch!==epoch||value.versionId!==versionId)return false;
      const pointer=plain(await models.MetaMarketingEffectiveCredential.findByPk(enrollmentId,options(transaction)));
      // A transient outage cannot erase a confirmed permanent permission failure.
      if(pointer&&PERMANENT.has(pointer.last_error)&&TEMPORARY.has(code))return false;
      const patch={last_error:code,last_error_at:now(),unknown_since:TEMPORARY.has(code)?pointer?.unknown_since??now():null};
      if(pointer){if(!await updatePointer({enrollmentId,epoch,versionId,digest:value.digest},patch,transaction))return false;}
      else await models.MetaMarketingEffectiveCredential.create({enrollment_id:enrollmentId,renewal_id:null,epoch:0,version_id:value.versionId,
        candidate_digest:value.digest,candidate_metadata:JSON.stringify(value.candidate),owner_receipt_digest:null,activated_at:enrollment.activated_at,last_healthy_at:enrollment.activated_at,...patch},{transaction,logging:false});
      return true;
    };
    return providedTransaction?work(providedTransaction):models.sequelize.transaction({isolationLevel:'REPEATABLE READ'},work);
  }
  async function recordHealthy({enrollmentId,epoch,versionId},observation,{transaction:providedTransaction}={}){
    if(!Number.isSafeInteger(observation?.verifiedAt)||Math.abs(observation.verifiedAt-+now())>60000)return false;
    const work=async transaction=>{
      const enrollment=plain(await models.MetaMarketingEnrollmentRequest.findByPk(enrollmentId,options(transaction)));if(enrollment?.state!=='active')return false;
      const flow=await models.MetaMarketingOAuthRequest.findByPk(enrollment.flow_id,options(transaction)),value=await resolve(enrollment,flow,transaction,{allowExpired:true});
      if(value.epoch!==epoch||value.versionId!==versionId||value.digest!==observation.digest)return false;
      const pointer=plain(await models.MetaMarketingEffectiveCredential.findByPk(enrollmentId,options(transaction)));
      if(pointer?.last_error_at&&+pointer.last_error_at>observation.verifiedAt)return false;
      const patch={last_error:null,last_error_at:null,unknown_since:null,last_healthy_at:new Date(observation.verifiedAt)};
      if(pointer){if(!await updatePointer({enrollmentId,epoch,versionId,digest:value.digest},patch,transaction))return false;}
      else await models.MetaMarketingEffectiveCredential.create({enrollment_id:enrollmentId,renewal_id:null,epoch:0,version_id:value.versionId,candidate_digest:value.digest,candidate_metadata:JSON.stringify(value.candidate),owner_receipt_digest:null,activated_at:enrollment.activated_at,...patch},{transaction,logging:false});return true;
    };
    return providedTransaction?work(providedTransaction):models.sequelize.transaction({isolationLevel:'REPEATABLE READ'},work);
  }
  return {resolve,getCredentialStatus,recordFailure,recordHealthy};
}
module.exports={createEffectiveCredentials,candidate,split,expiry,assetSetDigest,PERMANENT,TEMPORARY};
