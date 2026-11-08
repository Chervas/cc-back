'use strict';
const C=require('./metaMarketingBusiness.contract');
const plain=row=>row?.get?row.get({plain:true}):row;
function createSource({models,now=()=>new Date()}){
  const opts=transaction=>({raw:true,logging:false,...(transaction?{transaction,lock:transaction.LOCK.UPDATE}:{})});
  const order=require('./metaMarketingTransactionOrder.service').createOrder({models,unavailable:()=>C.fail('meta_business_unavailable',503)});
  async function forEnrollment(enrollment,transaction){
    if(!models.MetaMarketingBusinessHandover)return null;
    const raw=plain(await models.MetaMarketingBusinessHandover.findByPk(enrollment.enrollment_id,opts(transaction)));if(!raw)return null;
    const row=C.request(raw);
    if(row.state!=='active'||row.retired_at!==null||enrollment.state!=='active'||row.new_enrollment_id!==enrollment.enrollment_id
      ||row.handover_id!==enrollment.flow_id||row.scope_key!==enrollment.scope_key||row.scope_digest!==enrollment.scope_digest||row.clinic_ids!==enrollment.clinic_ids
      ||row.assets!==enrollment.assets||row.mapping_ids!==enrollment.mapping_ids||Number(row.new_canonical_id)!==Number(enrollment.meta_connection_id)
      ||C.sourceDigest(row)!==enrollment.flow_digest||row.candidate.digest!==enrollment.candidate_digest||row.candidate.subjectId!==enrollment.meta_user_id||row.candidate.appId!==enrollment.app_id)C.fail('meta_enrollment_scope_changed',409);
    const old=plain(await models.MetaMarketingEnrollmentRequest.findByPk(row.old_enrollment_id,opts(transaction)));
    if(!old||old.state!=='superseded'||JSON.stringify(C.freeze(old))!==JSON.stringify(row.source))C.fail('meta_enrollment_scope_changed',409);
    let remote;try{remote=C.receipt(JSON.parse(row.owner_receipt),row);}catch{C.fail('meta_enrollment_scope_changed',409);}
    if(!remote.handoverApplied||remote.newEnrollment.enrollmentId!==enrollment.enrollment_id)C.fail('meta_enrollment_scope_changed',409);
    require('./metaMarketingEnrollment.contract').receipt(remote.newEnrollment,enrollment,{states:['active']});
    const flow=C.sourceFlow(row),authority={enrollmentId:enrollment.enrollment_id,flowId:enrollment.flow_id,handoverId:row.handover_id,
      canonicalConnectionId:Number(enrollment.meta_connection_id),appId:enrollment.app_id,subjectId:enrollment.meta_user_id,scopeKey:enrollment.scope_key,
      clinicIds:C.clinics(enrollment.clinic_ids),mappingIds:JSON.parse(enrollment.mapping_ids),immutableDigest:C.sourceDigest(row),clientBusinessId:row.candidate.clientBusinessId,
      issuerKind:row.issuer_kind,issuerBusinessId:row.issuer_business_id,configId:row.config_id,graphVersion:row.graph_version};
    return {row,flow,candidate:row.candidate,authority};
  }
  async function prepareRetirement({scope,clinicIds}){
    if(!models.MetaMarketingBusinessHandover)return {rows:[]};
    const key=scope?.assignmentScope==='group'?'group:'+Number(scope.groupId):scope?.assignmentScope==='clinic'?'clinic:'+Number(scope.clinicId):null;
    if(!/^(clinic|group):[1-9][0-9]{0,9}$/.test(key||'')||!Array.isArray(clinicIds))C.fail('meta_business_scope_changed',409);
    const rows=await models.MetaMarketingBusinessHandover.findAll({attributes:['handover_id','scope_key','clinic_ids','app_id','old_enrollment_id','new_enrollment_id','state','retired_at'],where:{state:'active',retired_at:null},order:[['handover_id','ASC']],limit:1001,raw:true,logging:false});
    if(rows.length>1000)C.fail();return {rows:rows.filter(row=>row.scope_key===key||C.clinics(row.clinic_ids).some(id=>clinicIds.includes(id)))};
  }
  async function retireForScope({scope,clinicIds,preparedContext},transaction){
    if(!models.MetaMarketingBusinessHandover)return {retired:0,enrollmentsQueued:0};
    const key=scope?.assignmentScope==='group'?'group:'+Number(scope.groupId):scope?.assignmentScope==='clinic'?'clinic:'+Number(scope.clinicId):null;
    if(!/^(clinic|group):[1-9][0-9]{0,9}$/.test(key||'')||!Array.isArray(clinicIds))C.fail('meta_business_scope_changed',409);
    // Every caller must enter through the complete scope/enrollment prefix.
    // Falling back to a global H lock here would invert the normal reader.
    const selected=require('./metaScopeBlock.service').retirementRows(preparedContext,'business',transaction,{scope,clinicIds});
    const rows=selected.ids.length?await models.MetaMarketingBusinessHandover.findAll({...opts(transaction),where:{handover_id:selected.ids,state:'active',retired_at:null},order:[['handover_id','ASC']],limit:1001}):[];
    if(rows.length>1000)C.fail();let retired=0,enrollmentsQueued=0;
    for(const input of rows){const row=C.request(plain(input));if(row.scope_key!==key&&!row.clinicIds.some(id=>clinicIds.includes(id)))continue;
      const enrollment=plain(await models.MetaMarketingEnrollmentRequest.findByPk(row.handover_id,opts(transaction)));if(!enrollment||!['active','superseded','revoke_pending','revoked'].includes(enrollment.state))C.fail('meta_business_scope_changed',409);
      if(enrollment.state==='active'){
        await forEnrollment(enrollment,transaction);
        await models.MetaMarketingBrokerBinding.update({state:'blocked'},{where:{enrollment_id:enrollment.enrollment_id,meta_connection_id:enrollment.meta_connection_id},transaction,logging:false});
        await models.ClinicMetaAsset.update({isActive:false},{where:{id:JSON.parse(enrollment.mapping_ids),metaConnectionId:enrollment.meta_connection_id},transaction,logging:false});
        const [changed]=await models.MetaMarketingEnrollmentRequest.update({state:'revoke_pending',updated_at:now(),next_attempt_at:now(),attempts:0,last_error:null},{where:{enrollment_id:enrollment.enrollment_id,state:'active'},transaction,logging:false});if(changed!==1)C.fail('meta_business_scope_changed',409);enrollmentsQueued++;
      }
      await models.MetaMarketingBusinessHandover.update({retired_at:now()},{where:{handover_id:row.handover_id,retired_at:null},transaction,logging:false});retired++;
    }return {retired,enrollmentsQueued};
  }
  async function prepareConfirmedHandover(previous){
    if(!models.MetaMarketingBusinessHandover||!C.UUID.test(previous?.enrollmentId)||!C.UUID.test(previous?.versionId)||!C.positive(previous.connectionId)
      ||!Number.isSafeInteger(previous.epoch)||previous.epoch<0||!/^(clinic|group):[1-9][0-9]{0,9}$/.test(previous.scopeKey||''))return null;
    return order.prepareEnrollment(previous.enrollmentId,{scopeKey:previous.scopeKey});
  }
  async function getConfirmedHandover(previous,{transaction,prepared}={}){
    if(!models.MetaMarketingBusinessHandover||!C.UUID.test(previous?.enrollmentId)||!C.UUID.test(previous?.versionId)||!C.positive(previous.connectionId)
      ||!Number.isSafeInteger(previous.epoch)||previous.epoch<0||!/^(clinic|group):[1-9][0-9]{0,9}$/.test(previous.scopeKey||''))return null;
    if(!transaction){const captured=prepared||await prepareConfirmedHandover(previous);if(!captured)return null;return models.sequelize.transaction({isolationLevel:'REPEATABLE READ'},value=>getConfirmedHandover(previous,{transaction:value,prepared:captured}));}
    // Callers with their own incident transaction prepare before opening it.
    // A locator is not authority: every historical/current receipt check below
    // still runs under the current Enrollment -> ancestors -> H prefix.
    if(!prepared||prepared.enrollmentId!==previous?.enrollmentId||prepared.observed.scopeKey!==previous.scopeKey)C.fail('meta_business_unavailable',503);
    await order.lockPrepared(prepared,transaction);
    let id=previous.enrollmentId;const chain=[];
    for(let n=0;n<16;n++){
      const old=plain(await models.MetaMarketingEnrollmentRequest.findByPk(id,opts(transaction)));if(!old||old.state!=='superseded'||old.scope_key!==previous.scopeKey)return null;
      const rows=await models.MetaMarketingBusinessHandover.findAll({...opts(transaction),where:{scope_key:previous.scopeKey,old_enrollment_id:id,state:'active'},indexHints:[{type:'FORCE',values:['cc_meta_business_latest']}],limit:2});if(rows.length!==1)return null;
      let row,remote;try{row=C.request(plain(rows[0]));remote=C.receipt(JSON.parse(row.owner_receipt),row);}catch{return null;}
      if(!remote.handoverApplied||row.retired_at!==null||row.source_snapshot!==JSON.stringify(C.freeze(old)))return null;
      if(n===0&&(Number(row.expected_epoch)!==previous.epoch||row.expected_version_id!==previous.versionId||Number(old.meta_connection_id)!==previous.connectionId))return null;
      chain.push([row.handover_id,row.source_digest,C.hash(row.owner_receipt)]);id=row.handover_id;
      const current=plain(await models.MetaMarketingEnrollmentRequest.findByPk(id,opts(transaction)));if(!current)return null;
      if(current.state==='superseded')continue;if(current.state!=='active'||current.scope_key!==previous.scopeKey)return null;
      const authority=await require('./metaMarketingEnrollmentBinding.service').createBindings({models,now}).committed(id,transaction,{allowExpiredCredential:true});if(!authority.business)return null;
      const currentStatus=await require('./metaMarketingEffectiveCredential.service').createEffectiveCredentials({models,now}).getCredentialStatus(current,{transaction});
      const maintenanceStatus=await require('./metaMarketingCredentialMaintenance.service').createMaintenance({models,now}).getMaintenanceStatus(current,{transaction});
      return {currentStatus,maintenanceStatus,proof:{oldEnrollmentId:previous.enrollmentId,oldEpoch:previous.epoch,oldVersionId:previous.versionId,newEnrollmentId:id,oldConnectionId:previous.connectionId,newConnectionId:Number(current.meta_connection_id),scopeKey:previous.scopeKey,chainDigest:C.hash(JSON.stringify(chain))}};
    }return null;
  }
  return {forEnrollment,prepareRetirement,retireForScope,prepareConfirmedHandover,getConfirmedHandover};
}
module.exports={createSource};
