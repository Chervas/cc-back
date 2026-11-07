'use strict';
const {randomUUID}=require('node:crypto'),{Op,literal}=require('sequelize');
const C=require('./metaMarketingEnrollment.contract'),D=require('../../services/integrations-broker/src/meta-marketing-discovery-contract');
const {fromEnrollment}=require('../../services/platform-audit/src/meta-enrollment-event');
const plain=v=>v?.get?v.get({plain:true}):v;
const conflict=(code='meta_enrollment_scope_changed')=>C.fail(code,409);
const actor=row=>({scopeKey:row.scope_key,actorId:Number(row.actor_user_id),sessionRef:row.session_ref,sessionExpiresAt:row.session_expires_at});
const scopeValue=key=>{const [type,id]=key.split(':');return {assignmentScope:type,clinicId:type==='clinic'?Number(id):null,groupId:type==='group'?Number(id):null};};
const RESERVATION_REASONS=new Set(['meta_enrollment_disabled','meta_enrollment_invalid','meta_enrollment_scope_forbidden','meta_enrollment_scope_changed',
  'meta_enrollment_scope_blocked','meta_enrollment_identity_review','meta_enrollment_assignment_review','meta_enrollment_asset_in_use','meta_enrollment_asset_revoked',
  'meta_enrollment_selection_fixed','meta_enrollment_conflict','meta_recovery_invalid','meta_recovery_changed','meta_recovery_selection_changed','meta_recovery_expired',
  'meta_recovery_actor_required','meta_recovery_conflict','meta_recovery_canonical_invalid','meta_recovery_retired','meta_recovery_required',
  'meta_oauth_scope_changed','meta_oauth_scope_forbidden','meta_oauth_session_required','meta_oauth_scope_blocked','auth_email_verification_required','audit_unavailable',
  'broker_response_invalid','broker_unavailable','broker_timeout','rate_limited']);
function reservationRejected(phase,reason,refs,proof){
  // Diagnostics only: no provider/error text, identifiers or changes to the
  // returned error, transaction, authority or API contract.
  try{
    const selected=Array.isArray(refs)?refs.slice(0,100):[];
    const count=kind=>selected.filter(value=>typeof value==='string'&&new RegExp('^meta-'+kind+':[1-9][0-9]{0,29}$').test(value)).length;
    const data={event:'meta_enrollment_reservation_rejected',phase:['source','discovery','inventory','physical','identity','assignments','request','claims','attach','audit','assert_pending'].includes(phase)?phase:'source',
      reason:RESERVATION_REASONS.has(reason)?reason:'reservation_unavailable',selectedCount:selected.length,adCount:count('ad_account'),pageCount:count('facebook_page'),igCount:count('instagram_business')};
    if(proof&&Array.isArray(proof.aliases)){
      const original=new Set(proof.aliases.slice(0,100).map(alias=>'meta-'+alias.assetType+':'+String(alias.metaAssetId).replace(/^act_/,'')));
      data.originalRequiredCount=original.size;data.selectedOriginalCount=selected.filter(ref=>original.has(ref)).length;
    }
    process.stderr.write(JSON.stringify(data)+'\n');
  }catch{}
}
function createAuthority({models,sessions,oauth,now=()=>new Date(),enabled=()=>process.env.META_MARKETING_ENROLLMENT_ENABLED==='true',recoveryGuard}){
  const recovery=recoveryGuard||require('./metaMarketingLegacyRecovery.service').createRecovery({models,sessions,now});
  const S=require('./metaMarketingOAuthScope.service').createScope({models,sessions,now,recoveryGuard:recovery});
  const audit=require('./platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const options=transaction=>{
    if(!transaction?.LOCK?.UPDATE||transaction.finished)C.fail();
    return {transaction,lock:transaction.LOCK.UPDATE,logging:false,raw:true};
  };
  const gate=()=>{if(!enabled())C.fail('meta_enrollment_disabled',503);};
  const selectedRefs=value=>{
    if(!Array.isArray(value)||!value.length||value.length>100||new Set(value).size!==value.length
      ||value.some(v=>typeof v!=='string'||!/^meta-(ad_account|facebook_page|instagram_business):[1-9][0-9]{0,29}$/.test(v)))C.fail('meta_enrollment_invalid',400);
    return value.slice().sort();
  };
  async function source(input,id,transaction){
    gate();if(!C.UUID.test(id))C.fail('meta_enrollment_invalid',400);
    await S.authorize(input,transaction);
    const row=await models.MetaMarketingOAuthRequest.findByPk(id,options(transaction));
    if(!row||row.scope_key!==input.scopeKey||Number(row.actor_user_id)!==input.actorId||row.session_ref!==input.sessionRef
      ||+row.session_expires_at!==+input.sessionExpiresAt)C.fail('meta_enrollment_scope_forbidden',403);
    try{await S.revalidate(row,transaction);}
    catch(error){if(error?.code==='meta_oauth_scope_blocked')conflict('meta_enrollment_scope_blocked');throw error;}
    if(row.state!=='staged'||!row.candidate_metadata)conflict();
    let metadata;try{metadata=C.candidate(JSON.parse(row.candidate_metadata),row);}catch{conflict();}
    if([metadata.expiresAt,metadata.dataAccessExpiresAt].some(v=>v!==null&&v<=+now()))conflict();
    const proof=await recovery.forFlow(row,transaction,{phase:'pending'});
    if(await require('./metaScopeBlock.service').blocked(scopeValue(row.scope_key),{models,transaction,purpose:'meta'})&&!proof)conflict('meta_enrollment_scope_blocked');
    return {row,metadata,recovery:proof};
  }
  async function identity(row,metadata,transaction,{create=false,expectedId,recovery:proof}={}){
    const opts=options(transaction);
    const owner=await models.MetaMarketingEnrollmentIdentity.findByPk(metadata.subjectId,opts);
    const rows=await models.MetaConnection.findAll({...opts,attributes:['id','userId','metaUserId','broker_app_id','credentials_external',
      [literal('(accessToken IS NULL)'),'credentials_absent']],where:{[Op.or]:[{metaUserId:metadata.subjectId},...(expectedId?[{id:expectedId}]:[])]},order:[['id','ASC']],limit:proof?3:2});
    if(proof){
      if(proof.scopeKey!==row.scope_key||proof.appId!==metadata.appId||proof.subjectId!==metadata.subjectId)conflict('meta_enrollment_identity_review');
      const canonicalId=proof.canonicalConnectionId===null?null:Number(proof.canonicalConnectionId);
      if(proof.version===2&&canonicalId===null)conflict('meta_enrollment_identity_review');
      const original=rows.filter(v=>Number(v.id)===Number(proof.sourceConnectionId));
      if(original.length!==1||original[0].metaUserId!==metadata.subjectId
        ||rows.some(v=>Number(v.id)!==Number(proof.sourceConnectionId)&&Number(v.id)!==canonicalId))conflict('meta_enrollment_identity_review');
      let canonical=canonicalId===null?null:rows.find(v=>Number(v.id)===canonicalId);
      if(canonicalId!==null&&(!canonical||canonical.userId!==null||canonical.metaUserId!==metadata.subjectId||canonical.broker_app_id!==metadata.appId
        ||Number(canonical.credentials_external)!==1||Number(canonical.credentials_absent)!==1))conflict('meta_enrollment_identity_review');
      if(!canonical){
        if(proof.version===2)conflict('meta_enrollment_identity_review');
        if(!create||owner)conflict('meta_enrollment_identity_review');
        const created=await models.MetaConnection.create({userId:null,metaUserId:metadata.subjectId,credentials_external:true,broker_app_id:metadata.appId,
          accessToken:null,expiresAt:metadata.expiresAt===null?null:new Date(metadata.expiresAt)},{transaction,logging:false});
        canonical={id:Number(created.id)};
        await recovery.bindCanonical({flow:row,canonicalConnectionId:canonical.id},transaction);
      }
      if(expectedId!==undefined&&Number(canonical.id)!==Number(expectedId)
        ||owner&&(Number(owner.meta_connection_id)!==Number(canonical.id)||owner.app_id!==metadata.appId))conflict('meta_enrollment_identity_review');
      if(!create&&!owner)conflict('meta_enrollment_identity_review');
      if(!owner)await models.MetaMarketingEnrollmentIdentity.create({meta_user_id:metadata.subjectId,app_id:metadata.appId,meta_connection_id:Number(canonical.id),created_at:now()},{transaction,logging:false});
      if(proof.version===2)await recovery.bindCanonical({flow:row,canonicalConnectionId:Number(canonical.id)},transaction);
      return Number(canonical.id);
    }
    if(rows.length>1)conflict('meta_enrollment_identity_review');
    let current=rows[0];
    if(current&&(current.metaUserId!==metadata.subjectId||current.broker_app_id!==metadata.appId||Number(current.credentials_external)!==1
      ||Number(current.credentials_absent)!==1||!C.positive(Number(current.id))))conflict('meta_enrollment_identity_review');
    if(owner&&(!current||Number(owner.meta_connection_id)!==Number(current.id)||owner.app_id!==metadata.appId))conflict('meta_enrollment_identity_review');
    if(!create&&(!owner||!current||Number(current.id)!==Number(expectedId)))conflict('meta_enrollment_identity_review');
    if(!current){
      if(!create)conflict('meta_enrollment_identity_review');
      const created=await models.MetaConnection.create({userId:Number(row.actor_user_id),metaUserId:metadata.subjectId,
        credentials_external:true,broker_app_id:metadata.appId,accessToken:null,expiresAt:metadata.expiresAt===null?null:new Date(metadata.expiresAt)},
      {transaction,logging:false});
      current={id:Number(created.id),metaUserId:metadata.subjectId,broker_app_id:metadata.appId,credentials_external:true,credentials_absent:1};
    }
    if(!owner)await models.MetaMarketingEnrollmentIdentity.create({meta_user_id:metadata.subjectId,app_id:metadata.appId,meta_connection_id:Number(current.id),created_at:now()},{transaction,logging:false});
    return Number(current.id);
  }
  async function assignments(row,connectionId,transaction,proof=null){
    const opts=options(transaction),scope=scopeValue(row.scope_key),ids=C.clinics(row.clinic_ids);
    const clinics=await models.Clinica.findAll({...opts,attributes:['id_clinica','grupoClinicaId'],
      where:scope.assignmentScope==='group'?{grupoClinicaId:scope.groupId}:{id_clinica:scope.clinicId},order:[['id_clinica','ASC']],limit:1001});
    if(JSON.stringify(clinics.map(v=>Number(v.id_clinica)))!==row.clinic_ids)conflict();
    const groups=[...new Set(clinics.map(v=>Number(v.grupoClinicaId)).filter(C.positive))].sort((a,b)=>a-b);
    const keys=[...ids.map(id=>'clinic:'+id),...groups.map(id=>'group:'+id)];
    const grants=await models.MetaConnectionAssignment.findAll({...opts,attributes:['id','scopeKey','assignmentScope','clinicaId','grupoClinicaId','metaConnectionId','status'],
      where:{[Op.or]:[{scopeKey:{[Op.in]:keys}},{assignmentScope:'clinic',clinicaId:{[Op.in]:ids}},{assignmentScope:'group',grupoClinicaId:{[Op.in]:groups}}]},order:[['id','ASC']],limit:keys.length+1});
    if(grants.length>keys.length)conflict();
    for(const grant of grants){
      const type=grant.assignmentScope,id=Number(type==='clinic'?grant.clinicaId:grant.grupoClinicaId);
      // Preserve an exact, Root-pinned V2 legacy grant with a redundant group
      // FK only when the current clinic actually belongs to that same group.
      // A pinned disconnected grant stays disconnected; V2 grants no legacy access.
      // This is metadata compatibility, never a repair or a new generic grant.
      const pinnedClinicGroup=type==='clinic'&&proof?.version===2&&proof.scopeKey===row.scope_key
        &&JSON.stringify(proof.clinicIds)===row.clinic_ids&&C.positive(Number(proof.sourceConnectionId))
        &&Number(grant.metaConnectionId)===Number(proof.sourceConnectionId)&&['active','disconnected'].includes(grant.status)
        &&C.positive(Number(grant.grupoClinicaId))&&grants.filter(value=>value.scopeKey===grant.scopeKey).length===1
        &&clinics.some(clinic=>Number(clinic.id_clinica)===id&&Number(clinic.grupoClinicaId)===Number(grant.grupoClinicaId));
      if(!['clinic','group'].includes(type)||!C.positive(id)||grant.scopeKey!==type+':'+id
        ||(type==='clinic'?grant.grupoClinicaId!==null&&!pinnedClinicGroup:grant.clinicaId!==null))conflict();
    }
    const matching=key=>grants.filter(v=>v.scopeKey===key);
    const check=rows=>{if(rows.length>1||rows.length&&(rows[0].status!=='active'||Number(rows[0].metaConnectionId)!==connectionId))conflict('meta_enrollment_assignment_review');};
    if(proof){
      // The reviewed generation is the new Meta-only grant. The old generic
      // grants, including a disconnected clinic grant used by WhatsApp, remain
      // exactly as pinned by the recovery guard and are never broadened here.
      if(proof.scopeKey!==row.scope_key||JSON.stringify(proof.clinicIds)!==row.clinic_ids)conflict('meta_enrollment_assignment_review');
    }else{
      if(scope.assignmentScope==='group')check(matching(row.scope_key));
      for(const clinic of clinics){const direct=matching('clinic:'+clinic.id_clinica);check(direct.length?direct:matching('group:'+clinic.grupoClinicaId));}
    }
    const policies=groups.length?await models.GrupoClinica.findAll({...opts,attributes:['id_grupo','facebook_assignment_mode','facebook_primary_asset_id','instagram_assignment_mode','instagram_primary_asset_id'],
      where:{id_grupo:{[Op.in]:groups}},order:[['id_grupo','ASC']],limit:groups.length+1}):[];
    if(policies.length!==groups.length)conflict();
    // Existing primary choices are preserved, never replaced by this reservation.
    // References/shares of newly allocated mapping IDs must also be checked by
    // the final assignment writer before its commit.
    return C.hash(JSON.stringify([connectionId,clinics,grants,policies]));
  }
  async function physical(selected,transaction,enrollmentId=null,proof=null){
    const opts=options(transaction),refs=C.physical(selected),pages=refs.filter(v=>v.startsWith('meta-facebook_page:')).map(v=>v.split(':')[1]);
    const claims=await models.MetaMarketingEnrollmentClaim.findAll({...opts,attributes:['asset_ref','enrollment_id'],where:{asset_ref:{[Op.in]:refs}},order:[['asset_ref','ASC']],limit:refs.length+1});
    if(enrollmentId){
      const owned=await models.MetaMarketingEnrollmentClaim.findAll({...opts,attributes:['asset_ref','enrollment_id'],where:{enrollment_id:enrollmentId},order:[['asset_ref','ASC']],limit:201});
      if(claims.length!==refs.length||claims.some(v=>v.enrollment_id!==enrollmentId)||JSON.stringify(owned.map(v=>v.asset_ref))!==JSON.stringify(refs))conflict('meta_enrollment_asset_in_use');
    }else if(claims.length)conflict('meta_enrollment_asset_in_use');
    const aliases=[];
    for(const kind of ['ad_account','facebook_page','instagram_business']){
      const ids=refs.filter(v=>v.startsWith('meta-'+kind+':')).flatMap(v=>kind==='ad_account'?[v.split(':')[1],'act_'+v.split(':')[1]]:[v.split(':')[1]]);
      if(ids.length)aliases.push({assetType:kind,metaAssetId:{[Op.in]:ids}});
    }
    if(proof){
      if(!Array.isArray(proof.mappingIds)||!proof.mappingIds.length||!Array.isArray(proof.aliases)
        ||proof.version!==2&&(selected.some(v=>v.kind!=='ad_account')||selected.length!==proof.mappingIds.length))conflict('meta_enrollment_asset_in_use');
      if(proof.version===2)require('./metaMarketingLegacyRecovery.service').selection(proof,selected);
      const expected=proof.aliases.filter(v=>proof.mappingIds.includes(Number(v.id)));
      const current=await models.ClinicMetaAsset.findAll({...opts,attributes:proof.version===2?require('./metaMarketingLegacyRecovery.service').ALIAS_ATTRIBUTES:['id','metaConnectionId','assetType','metaAssetId','assignmentScope','clinicaId','grupoClinicaId','isActive',
        [literal('(pageAccessToken IS NULL AND waAccessToken IS NULL AND additionalData IS NULL)'),'credentials_absent']],where:{[Op.or]:aliases},order:[['id','ASC']],limit:201});
      if(proof.version!==2&&expected.length!==selected.length||current.length!==expected.length)conflict('meta_enrollment_asset_in_use');
      if(proof.version===2&&require('./metaMarketingLegacyRecovery.service').encode(require('./metaMarketingLegacyRecovery.service').normalizeAliases(current))
        !==require('./metaMarketingLegacyRecovery.service').encode(proof.legacyAliases))conflict('meta_enrollment_asset_in_use');
      for(const original of expected){
        const found=current.find(v=>Number(v.id)===Number(original.id));
        const ref='meta-'+original.assetType+':'+String(original.metaAssetId).replace(/^act_/,'');
        if(!found||!selected.some(v=>v.assetRef===ref)||proof.version!==2&&Number(found.credentials_absent)!==1
          ||Number(found.metaConnectionId)!==Number(proof.sourceConnectionId)
          ||['assetType','metaAssetId','assignmentScope','clinicaId','grupoClinicaId'].some(key=>found[key]!==original[key])
          ||Number(found.isActive)!==Number(original.isActive))conflict('meta_enrollment_asset_in_use');
      }
    }else if(await models.ClinicMetaAsset.findOne({...opts,attributes:['id'],where:{[Op.or]:aliases}}))conflict('meta_enrollment_asset_in_use');
    const where={[Op.or]:[{asset_ref:{[Op.in]:refs}},...(pages.length?[{parent_page_id:{[Op.in]:pages}}]:[])]};
    if(await models.MetaMarketingBrokerBinding.findOne({...opts,attributes:['mapping_id'],where}))conflict('meta_enrollment_asset_in_use');
    if(await models.MetaMarketingBrokerRevocation.findOne({...opts,attributes:['tuple_hash'],where}))conflict('meta_enrollment_asset_revoked');
    return refs;
  }
  async function assertPending(request,transaction){
    const saved=C.request(plain(request));
    if(!['prepare_pending','prepared','activate_pending'].includes(saved.state)||saved.mappingIds.length)conflict();
    const {row,metadata,recovery:proof}=await source(actor(saved),saved.flow_id,transaction);
    if(C.sourceDigest(row)!==saved.flow_digest||metadata.digest!==saved.candidate_digest||metadata.subjectId!==saved.meta_user_id||metadata.appId!==saved.app_id
      ||row.scope_digest!==saved.scope_digest||row.connection_ref!==saved.connection_ref||row.clinic_ids!==saved.clinic_ids)conflict();
    await identity(row,metadata,transaction,{expectedId:Number(saved.meta_connection_id),recovery:proof});
    if(await assignments(row,Number(saved.meta_connection_id),transaction,proof)!==saved.assignment_digest)conflict();
    await physical(saved.selected,transaction,saved.enrollment_id,proof);gate();return saved;
  }
  async function reserve(input,flowId,assetRefs){
    let phase='source',proof=null,refs;
    try{gate();refs=selectedRefs(assetRefs);if(!C.UUID.test(flowId)||typeof oauth?.assets!=='function')C.fail('meta_enrollment_invalid',400);}
    catch(error){reservationRejected(phase,error?.code,assetRefs,proof);throw error;}
    // Inventory can only enter through the authenticated OAuth consumer. The
    // caller supplies selected typed IDs, never parent/name/candidate metadata.
    const startedAt=+now();let discovered;phase='discovery';
    try{discovered=await oauth.assets(input,flowId);}catch(error){reservationRejected(phase,error?.code,refs,proof);throw error;}
    phase='source';
    try{return await models.sequelize.transaction({isolationLevel:'REPEATABLE READ'},async transaction=>{
      phase='source';const {row,metadata,recovery:currentProof}=await source(input,flowId,transaction);proof=currentProof;
      phase='inventory';
      let inventory;try{inventory=D.validateResult(discovered.inventory,{flowId,candidateDigest:metadata.digest,scopeDigest:row.scope_digest,scopeKey:row.scope_key,
        clinicSetDigest:C.hash(row.clinic_ids),metadata,startedAt,now:+now()});}catch{conflict();}
      const chosen=inventory.assets.filter(v=>refs.includes(v.assetRef));if(chosen.length!==refs.length)C.fail('meta_enrollment_invalid',400);
      const selected=C.assets(chosen.map(C.E.identity));
      phase='request';const existing=await models.MetaMarketingEnrollmentRequest.findOne({...options(transaction),where:{flow_id:flowId}});
      if(existing){
        const saved=C.request(existing);if(saved.assets!==JSON.stringify(selected))conflict('meta_enrollment_selection_fixed');
        phase='assert_pending';await assertPending(saved,transaction);return saved;
      }
      phase='physical';const physicalRefs=await physical(selected,transaction,null,proof);
      phase='identity';const connectionId=await identity(row,metadata,transaction,{create:true,recovery:proof});
      phase='assignments';const assignmentDigest=await assignments(row,connectionId,transaction,proof),date=now();
      phase='request';
      const value=C.request({enrollment_id:randomUUID(),flow_id:flowId,scope_key:row.scope_key,clinic_ids:row.clinic_ids,connection_ref:row.connection_ref,scope_digest:row.scope_digest,
        flow_digest:C.sourceDigest(row),candidate_digest:metadata.digest,meta_user_id:metadata.subjectId,app_id:metadata.appId,meta_connection_id:connectionId,assignment_digest:assignmentDigest,
        assets:JSON.stringify(selected),mapping_ids:'[]',actor_user_id:Number(row.actor_user_id),session_ref:row.session_ref,session_expires_at:row.session_expires_at,
        prepare_request_id:randomUUID(),activate_request_id:randomUUID(),revoke_request_id:randomUUID(),selection_digest:null,state:'prepare_pending',requested_at:date,updated_at:date,
        prepared_at:null,activated_at:null,revoked_at:null,attempts:0,next_attempt_at:date,lease_token:null,lease_until:null,last_error:null});
      await models.MetaMarketingEnrollmentRequest.create(value,{transaction,logging:false});
      phase='claims';await models.MetaMarketingEnrollmentClaim.bulkCreate(physicalRefs.map(asset_ref=>({asset_ref,enrollment_id:value.enrollment_id,created_at:date})),{transaction,logging:false});
      phase='attach';if(proof)await recovery.attachEnrollment({flow:row,enrollmentId:value.enrollment_id},transaction);
      phase='audit';
      const health=await audit.health(date,{includeUnresolved:false,transaction});
      if(!Number.isSafeInteger(health.pending)||health.pending>=10000||!Number.isFinite(health.oldestAgeSeconds)||health.oldestAgeSeconds>=3600)C.fail('audit_unavailable');
      await audit.append(fromEnrollment(value,'meta_enrollment_requested',{now:date}),{transaction});
      phase='assert_pending';await assertPending(value,transaction);return value;
    });}catch(error){
      const normalize=error?.name==='SequelizeUniqueConstraintError'||['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(error?.original?.code);
      reservationRejected(phase,normalize?'meta_enrollment_conflict':error?.code,refs,proof);
      if(normalize)conflict('meta_enrollment_conflict');throw error;
    }
  }
  return {reserve,assertPending};
}
module.exports={createAuthority};
