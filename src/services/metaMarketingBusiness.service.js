'use strict';
const {randomUUID,randomBytes}=require('node:crypto'),{Op,literal}=require('sequelize');
const C=require('./metaMarketingBusiness.contract');
const plain=row=>row?.get?row.get({plain:true}):row;
function configurationFrom(env,scopeKey){
  let modes;try{modes=JSON.parse(env.META_MARKETING_BUSINESS_SCOPE_MODES||'null');}catch{return null;}
  if(!modes||Object.getPrototypeOf(modes)!==Object.prototype||Object.keys(modes).length>64||Object.entries(modes).some(([key,value])=>!/^(clinic|group):[1-9][0-9]{0,9}$/.test(key)||!C.ISSUERS.includes(value)))return null;
  const issuerKind=modes[scopeKey];if(!issuerKind)return null;
  return issuerKind===C.A.ISSUER?{issuerKind,issuerBusinessId:env.META_MARKETING_AGENCY_ISSUER_BUSINESS_ID,configId:env.META_MARKETING_AGENCY_SETUP_CONFIG_ID,graphVersion:env.META_MARKETING_AGENCY_GRAPH_VERSION}
    :{issuerKind,issuerBusinessId:null,configId:env.META_MARKETING_BUSINESS_CONFIG_ID,graphVersion:env.META_MARKETING_BUSINESS_GRAPH_VERSION};
}
const runtimeConfiguration=scopeKey=>configurationFrom(process.env,scopeKey);
function createService({models,sessions,client,now=()=>new Date(),enabled=()=>process.env.META_MARKETING_BUSINESS_ENABLED==='true',
  configuration=runtimeConfiguration,
  returnOrigin=C.frontendOrigin(),drain:providedDrain,audit:providedAudit}={}){
  const H=models.MetaMarketingBusinessHandover,R=models.MetaMarketingEnrollmentRequest;
  const scope=require('./metaMarketingOAuthScope.service').createScope({models,sessions,now}),bindings=require('./metaMarketingEnrollmentBinding.service').createBindings({models,sessions,now});
  const credentials=C.F.createEffectiveCredentials({models,now}),audit=providedAudit||require('./platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const drain=providedDrain||require('./metaMarketingBusinessDrain.service').createDrain({models,now});
  const tx=work=>models.sequelize.transaction({isolationLevel:'REPEATABLE READ'},work),opts=transaction=>({transaction,lock:transaction.LOCK.UPDATE,raw:true,logging:false});
  const order=require('./metaMarketingTransactionOrder.service').createOrder({models,authorize:scope.authorize,unavailable:()=>C.fail('meta_business_unavailable',503)});
  const gate=()=>{if(!enabled())C.fail('meta_business_disabled',503);if(!H)C.fail();};
  const policy=scopeKey=>{const value=configuration(scopeKey);if(!value||!C.ISSUERS.includes(value.issuerKind)||!/^[1-9][0-9]{0,29}$/.test(value.configId||'')||!/^v(?:24|25|26|27)\.0$/.test(value.graphVersion||'')
    ||(value.issuerKind===C.A.ISSUER?value.graphVersion!=='v27.0'||!/^[1-9][0-9]{0,29}$/.test(value.issuerBusinessId||''):value.issuerBusinessId!==null))C.fail();return value;};
  const actor=row=>({scopeKey:row.scope_key,actorId:Number(row.actor_user_id),sessionRef:row.session_ref,sessionExpiresAt:row.session_expires_at});
  async function record(row,reason,transaction,input){
    const health=await audit.health(now(),{includeUnresolved:false,transaction});if(!Number.isSafeInteger(health.pending)||health.pending>=10000||!Number.isFinite(health.oldestAgeSeconds)||health.oldestAgeSeconds>=3600)C.fail('audit_unavailable');
    await audit.append(require('../../services/platform-audit/src/meta-business-continuity-event').fromHandover(row,reason,{now:now(),...(input?{actorId:input.actorId,sessionRef:input.sessionRef}:{})}),{transaction});
  }
  async function current(id,transaction){
    if(!C.UUID.test(id))C.fail('meta_business_invalid',400);const observed=plain(await H.findByPk(id,{transaction,raw:true,logging:false}));if(!observed)C.fail('meta_business_scope_forbidden',403);
    await R.findByPk(observed.old_enrollment_id,opts(transaction));const row=plain(await H.findByPk(id,opts(transaction)));if(!row)C.fail();return C.request(row);
  }
  async function update(row,patch,transaction){
    const state=patch.state??row.state,changes={...patch,pending_scope_key:C.TERMINAL.includes(state)?null:row.scope_key,updated_at:now()};
    const [changed]=await H.update(changes,{where:{handover_id:row.handover_id,state:row.state},transaction,logging:false});if(changed!==1)C.fail('meta_business_busy',409);return C.request({...row,...changes});
  }
  async function admission(input,transaction,enrollmentId=null,handoverId=null){
    const raw=plain(enrollmentId?await R.findByPk(enrollmentId,opts(transaction)):await R.findOne({...opts(transaction),where:{scope_key:input.scopeKey,state:'active'},order:[['requested_at','DESC'],['enrollment_id','DESC']]}));
    // Human callers preauthorize in a separate transaction. Match the reader's
    // enrollment -> clinic order and recheck current session/email/WRITE access
    // before inspecting the row or loading assets, including an absent result.
    if(input)await scope.authorize(input,transaction);
    if(!raw)return null;const enrollment=require('./metaMarketingEnrollment.contract').request(raw);if(enrollment.state!=='active'||input&&enrollment.scope_key!==input.scopeKey)C.fail('meta_business_scope_changed',409);
    const authority=await bindings.committed(enrollment.enrollment_id,transaction,{allowExpiredCredential:true,allowBusinessHandover:handoverId});
    const effective=await credentials.resolve(enrollment,null,transaction,{allowExpired:true}).catch(async error=>{
      if(error.code!=='meta_credential_version_invalid')throw error;const flow=await models.MetaMarketingOAuthRequest.findByPk(enrollment.flow_id,opts(transaction));return credentials.resolve(enrollment,flow,transaction,{allowExpired:true});});
    return {enrollment,authority,effective};
  }
  async function assertRequest(row,transaction,{input=null,origin=false,version=true}={}){
    if(input){await scope.authorize(input,transaction);if(input.scopeKey!==row.scope_key||input.actorId!==Number(row.actor_user_id))C.fail('meta_business_scope_forbidden',403);}
    if(origin){
      const value=input||actor(row);if(value.sessionRef!==row.session_ref||+value.sessionExpiresAt<+row.session_expires_at)C.fail('meta_business_session_required',409);
      try{await scope.authorize(actor(row),transaction);}catch(error){if(error.httpStatus===401)C.fail('meta_business_session_required',409);throw error;}
    }
    const selected=policy(row.scope_key);if(selected.issuerKind!==row.issuer_kind||selected.issuerBusinessId!==row.issuer_business_id||selected.configId!==row.config_id||selected.graphVersion!==row.graph_version)C.fail('meta_business_scope_changed',409);
    const context=await admission(null,transaction,row.old_enrollment_id,row.handover_id);if(!context||JSON.stringify(C.freeze(context.enrollment))!==row.source_snapshot)C.fail('meta_business_scope_changed',409);
    if(version&&(context.effective.epoch!==Number(row.expected_epoch)||context.effective.versionId!==row.expected_version_id||context.effective.digest!==row.expected_candidate_digest))C.fail('meta_business_version_changed',409);
    return context;
  }
  async function call(row,name,payload){
    const requestId=name==='status'?randomUUID():row[name+'_request_id'],response=await client.execute({requestId,operation:C.B.OPERATIONS[name],tenantRef:'clinic:'+row.clinicIds[0],connectionRef:row.connection_ref,assetRef:'meta-enroll:'+row.scope_key,payload},{timeoutMs:['finish','activate'].includes(name)?30000:10000});
    if(!C.exact(response,'requestId,data,replayed')||response.requestId!==requestId||typeof response.replayed!=='boolean'||name==='status'&&response.replayed)C.fail('broker_response_invalid');
    if(name!=='begin')return C.receipt(response.data,row);
    const value=response.data;if(!C.exact(value,'handoverId,flowId,newEnrollmentId,oldEnrollmentId,oldGrantDigest,authUrl,expiresAt')||value.handoverId!==row.handover_id||value.flowId!==row.handover_id||value.newEnrollmentId!==row.handover_id||value.oldEnrollmentId!==row.old_enrollment_id||!C.HASH.test(value.oldGrantDigest)||value.expiresAt!==+row.expires_at)C.fail('broker_response_invalid');
    let url;try{url=new URL(value.authUrl);}catch{C.fail('broker_response_invalid');}
    const expected={client_id:row.app_id,redirect_uri:row.redirect_uri,response_type:'code',config_id:row.config_id,state:payload.state,override_default_response_type:'true'};
    if(url.origin!=='https://www.facebook.com'||url.pathname!=='/'+row.graph_version+'/dialog/oauth'||url.username||url.password||url.hash||[...url.searchParams.keys()].sort().join(',')!==Object.keys(expected).sort().join(',')||Object.entries(expected).some(([key,value])=>url.searchParams.get(key)!==value))C.fail('broker_response_invalid');return value;
  }
  async function queueCancel(id,code=null,input=null){return tx(async transaction=>{const row=await current(id,transaction);if(C.TERMINAL.includes(row.state))return row;
    if(input){await scope.authorize(input,transaction);if(input.scopeKey!==row.scope_key||input.actorId!==Number(row.actor_user_id))C.fail('meta_business_scope_forbidden',403);}
    const next=await update(row,{state:'cancel_pending',last_error:code,next_attempt_at:now()},transaction);if(row.state!=='cancel_pending')await record(next,'meta_business_cancel_requested',transaction,input);return next;});}
  async function cancelled(row,remote,transaction){
    if(C.TERMINAL.includes(row.state))return row;
    const rejected=!!row.last_error&&!['meta_business_disabled'].includes(row.last_error),next=await update(row,{state:rejected?'rejected':'cancelled',owner_receipt:JSON.stringify(remote),completed_at:now(),lease_token:null,lease_until:null},transaction);
    await drain.release(row.old_enrollment_id,{transaction,handoverId:row.handover_id});await record(next,rejected?'meta_business_rejected':'meta_business_cancelled',transaction);return next;
  }
  async function canonical(row,transaction){
    const candidate=row.candidate,o=opts(transaction),owner=plain(await models.MetaMarketingEnrollmentIdentity.findByPk(candidate.subjectId,o));
    const rows=await models.MetaConnection.findAll({...o,attributes:['id','userId','metaUserId','broker_app_id','credentials_external',[literal('(accessToken IS NULL)'),'credentials_absent']],where:{metaUserId:candidate.subjectId},limit:2});
    if(rows.length>1||rows.length===1&&(!owner||Number(owner.meta_connection_id)!==Number(rows[0].id)||owner.app_id!==row.app_id||rows[0].userId!==null||rows[0].broker_app_id!==row.app_id||Number(rows[0].credentials_external)!==1||Number(rows[0].credentials_absent)!==1)||rows.length===0&&owner)C.fail('meta_business_identity_mismatch',409);
    if(rows.length)return Number(rows[0].id);
    const created=await models.MetaConnection.create({userId:null,metaUserId:candidate.subjectId,broker_app_id:row.app_id,credentials_external:true,accessToken:null,expiresAt:new Date(candidate.expiresAt)},{transaction,logging:false});
    await models.MetaMarketingEnrollmentIdentity.create({meta_user_id:candidate.subjectId,app_id:row.app_id,meta_connection_id:Number(created.id),created_at:now()},{transaction,logging:false});return Number(created.id);
  }
  async function apply(row,remote,transaction){
    if(row.state==='active')return row;
    if(!['activate_pending','cancel_pending'].includes(row.state)||!row.activate_sent_at||!remote.handoverApplied||!row.candidate||remote.candidate.digest!==row.candidate.digest)C.fail('broker_response_invalid');
    let context;try{context=await assertRequest(row,transaction);}catch(error){
      if(![403,409].includes(error.httpStatus))throw error;
      const rejected=await update(row,{state:'rejected',owner_receipt:JSON.stringify(remote),last_error:'meta_business_scope_changed',completed_at:now(),lease_token:null,lease_until:null},transaction);
      await record(rejected,'meta_business_rejected',transaction);return rejected;
    }
    const old=context.enrollment;
    await drain.assert(old.enrollment_id,row.drain_digest,{transaction,handoverId:row.handover_id,ownerDrain:remote.drain,oldGrantDigest:row.old_grant_digest});
    const canonicalId=await canonical(row,transaction),date=now(),newRow={...old,enrollment_id:row.handover_id,flow_id:row.handover_id,scope_digest:row.scope_digest,flow_digest:C.sourceDigest(row),candidate_digest:row.candidate.digest,
      meta_user_id:row.candidate.subjectId,meta_connection_id:canonicalId,actor_user_id:row.actor_user_id,session_ref:row.session_ref,session_expires_at:row.session_expires_at,requested_at:row.requested_at,
      prepared_at:new Date(remote.newEnrollment.preparedAt),activated_at:new Date(remote.newEnrollment.activatedAt),prepare_request_id:row.begin_request_id,activate_request_id:row.activate_request_id,revoke_request_id:row.revoke_request_id,
      selection_digest:remote.newEnrollment.selectionDigest,assignment_digest:C.hash(JSON.stringify([row.source_digest,row.scope_digest,row.asset_set_digest])),state:'active',updated_at:date,next_attempt_at:new Date(+date+300000),revoked_at:null,
      lease_token:null,lease_until:null,prepare_sent_at:null,activate_sent_at:null,last_error:null,attempts:0};
    delete newRow.clinicIds;delete newRow.selected;delete newRow.mappingIds;
    require('./metaMarketingEnrollment.contract').receipt(remote.newEnrollment,newRow,{states:['active']});
    const [superseded]=await R.update({state:'superseded',updated_at:date,lease_token:null,lease_until:null,last_error:null},{where:{enrollment_id:old.enrollment_id,state:'active'},transaction,logging:false});if(superseded!==1)C.fail('meta_business_scope_changed',409);
    await R.create(newRow,{transaction,logging:false});
    const refs=C.physical(old.selected),[claims]=await models.MetaMarketingEnrollmentClaim.update({enrollment_id:row.handover_id},{where:{enrollment_id:old.enrollment_id,asset_ref:{[Op.in]:refs}},transaction,logging:false});if(claims!==refs.length)C.fail('meta_business_scope_changed',409);
    const [mappings]=await models.ClinicMetaAsset.update({metaConnectionId:canonicalId},{where:{id:{[Op.in]:old.mappingIds},metaConnectionId:old.meta_connection_id,isActive:true},transaction,logging:false});if(mappings!==old.mappingIds.length)C.fail('meta_business_scope_changed',409);
    const [changedBindings]=await models.MetaMarketingBrokerBinding.update({enrollment_id:row.handover_id,meta_connection_id:canonicalId,meta_user_id:row.candidate.subjectId,app_id:row.app_id},{where:{enrollment_id:old.enrollment_id,mapping_id:{[Op.in]:old.mappingIds},state:'active'},transaction,logging:false});if(changedBindings!==old.mappingIds.length)C.fail('meta_business_scope_changed',409);
    const next=await update(row,{state:'active',new_canonical_id:canonicalId,owner_receipt:JSON.stringify(remote),completed_at:date,last_error:null,lease_token:null,lease_until:null},transaction);
    await bindings.committed(row.handover_id,transaction);await drain.release(old.enrollment_id,{transaction,handoverId:row.handover_id});
    await require('./metaMarketingCredentialMaintenance.service').createMaintenance({models,now}).schedule(newRow,{transaction});await record(next,'meta_business_activated',transaction);return next;
  }
  async function reconcileId(id){
    let row=await tx(transaction=>current(id,transaction));if(C.TERMINAL.includes(row.state))return row;
    if(!enabled()&&row.state!=='cancel_pending')row=await queueCancel(id,'meta_business_disabled');
    let remote;try{remote=await call(row,row.state==='cancel_pending'?'abort':'status',{handoverId:id});}
    catch(error){if(row.state!=='cancel_pending'||error.code!=='scope_denied')throw error;remote=await call(row,'status',{handoverId:id});if(remote.status!=='not_found')throw error;}
    if(remote.handoverApplied)return tx(async transaction=>apply(await current(id,transaction),remote,transaction));
    if(['cancel_pending','begin_pending'].includes(row.state)){
      if(!['aborted','rejected','interrupted','not_found'].includes(remote.status))remote=await call(row,'abort',{handoverId:id});
      if(remote.handoverApplied)return tx(async transaction=>apply(await current(id,transaction),remote,transaction));return tx(async transaction=>cancelled(await current(id,transaction),remote,transaction));
    }
    if(['aborted','rejected','interrupted','not_found'].includes(remote.status)){await queueCancel(id,'meta_business_candidate_rejected');return reconcileId(id);}
    if(row.state==='activate_pending'){
      if(!remote.drain)remote=await call(row,'drain',{handoverId:id});
      if(remote.handoverApplied)return tx(async transaction=>apply(await current(id,transaction),remote,transaction));
      const ready=await tx(async transaction=>{const fresh=await current(id,transaction);if(fresh.state!=='activate_pending')return false;const context=await assertRequest(fresh,transaction,{origin:true});
        const result=await drain.begin(context.enrollment,{transaction,handoverId:id,ownerDrain:remote.drain,oldGrantDigest:fresh.old_grant_digest});
        const next=await update(fresh,{drain_digest:result.drainDigest,owner_receipt:JSON.stringify(remote),last_error:result.ready?null:'meta_business_drain_pending',next_attempt_at:new Date(+now()+30000)},transaction);
        if(!result.ready)return false;await drain.assert(fresh.old_enrollment_id,result.drainDigest,{transaction,handoverId:id,ownerDrain:remote.drain,oldGrantDigest:fresh.old_grant_digest});
        await update(next,{activate_sent_at:next.activate_sent_at||now()},transaction);return true;});
      if(!ready)return tx(transaction=>current(id,transaction));
      if(!enabled()){await queueCancel(id,'meta_business_disabled');return reconcileId(id);}
      row=await tx(transaction=>current(id,transaction));if(row.state!=='activate_pending')return reconcileId(id);
      remote=await call(row,'activate',{handoverId:id,oldEnrollmentId:row.old_enrollment_id,newEnrollmentId:id,oldGrantDigest:row.old_grant_digest,
        expectedEpoch:Number(row.expected_epoch),expectedVersionId:row.expected_version_id,expectedCandidateDigest:row.expected_candidate_digest,candidateVersionId:id,candidateDigest:row.candidate.digest,drainDigest:row.drain_digest});
      return tx(async transaction=>apply(await current(id,transaction),remote,transaction));
    }
    return tx(async transaction=>{const fresh=await current(id,transaction);if(C.TERMINAL.includes(fresh.state)||['activate_pending','cancel_pending'].includes(fresh.state))return fresh;const context=await assertRequest(fresh,transaction,{origin:true});
      if(remote.status==='staged'){
        const value=C.candidate({versionId:remote.candidate.versionId,digest:remote.candidate.digest,...remote.candidate.metadata},C.pin(fresh));
        if(C.F.expiry(value)<=+now())C.fail('meta_business_expired',409);if(context.effective.metadata.tokenType==='USER'&&value.subjectId===context.enrollment.meta_user_id)C.fail('meta_business_identity_mismatch',409);
        if(context.effective.metadata.tokenType==='SYSTEM_USER'&&(C.issuer(value)!==C.issuer(context.effective.metadata)||(C.issuer(value)===C.A.ISSUER?['subjectId','issuerBusinessId','systemUserId','configId','graphVersion']:['subjectId','clientBusinessId','configId','graphVersion']).some(key=>value[key]!==context.effective.metadata[key])))C.fail('meta_business_identity_mismatch',409);
        if(fresh.candidate_metadata!==null&&fresh.candidate_metadata!==JSON.stringify(value))C.fail('broker_response_invalid');
        const next=await update(fresh,{state:'staged',candidate_metadata:JSON.stringify(value),owner_receipt:JSON.stringify(remote),last_error:null,next_attempt_at:new Date(+now()+30000)},transaction);if(fresh.state!=='staged')await record(next,'meta_business_staged',transaction);return next;
      }
      if(+fresh.expires_at<=+now())C.fail('meta_business_expired',409);return update(fresh,{state:remote.status==='processing'?'processing':'awaiting',owner_receipt:JSON.stringify(remote),next_attempt_at:new Date(+now()+30000)},transaction);
    });
  }
  const pendingDto=(row,input)=>({requestId:row.handover_id,status:row.state,assetCount:row.selected.length,issuerKind:row.issuer_kind,providerBusinessId:row.issuer_kind===C.A.ISSUER?row.issuer_business_id:null,candidateDigest:row.candidate?.digest??null,clientBusinessId:row.candidate?.clientBusinessId??null,subjectId:row.candidate?.subjectId??null,appId:row.candidate?.appId??null,
    candidateExpiresAt:row.candidate?.expiresAt??null,candidateDataAccessExpiresAt:row.candidate?.dataAccessExpiresAt??null,
    canConfirm:enabled()&&row.state==='staged'&&Number(row.actor_user_id)===input.actorId&&row.session_ref===input.sessionRef&&+input.sessionExpiresAt>=+row.session_expires_at&&+row.session_expires_at>+now()&&C.F.expiry(row.candidate)>+now(),canCancel:!C.TERMINAL.includes(row.state),lastError:row.last_error});
  const service={
    async overview(input){if(!enabled())return {enabled:false,authorizationMode:null,canBegin:false,current:null,pending:null};
      return order.scope(input,{active:true},async({transaction,enrollment,input})=>{
      const observed=await H.findOne({where:{pending_scope_key:input.scopeKey},attributes:['handover_id'],transaction,raw:true,logging:false});
      let authorizationMode=null;try{authorizationMode=policy(input.scopeKey).issuerKind;}catch{}
      const context=enrollment?await admission(input,transaction,enrollment.enrollment_id,observed?.handover_id??null):null;if(!context)return {enabled:true,authorizationMode,canBegin:false,current:null,pending:null};
      const raw=plain(await H.findOne({...opts(transaction),where:{pending_scope_key:input.scopeKey}})||await H.findOne({...opts(transaction),where:{scope_key:input.scopeKey},order:[['requested_at','DESC'],['handover_id','DESC']]})),row=raw?C.request(raw):null;
      const maintenance=await require('./metaMarketingCredentialMaintenance.service').createMaintenance({models,now}).getMaintenanceStatus(context.enrollment,{transaction});
      return {enabled:true,authorizationMode,canBegin:authorizationMode!==null&&(!row||C.TERMINAL.includes(row.state)),current:{enrollmentId:context.enrollment.enrollment_id,assetCount:context.enrollment.selected.length,tokenType:context.effective.metadata.tokenType,issuerKind:C.issuer(context.effective.metadata),providerBusinessId:C.providerBusinessId(context.effective.metadata),clientBusinessId:context.effective.metadata.clientBusinessId??null,subjectId:context.enrollment.meta_user_id,maintenance:{mechanism:maintenance.automaticSupported?(maintenance.mechanism==='agency_system_user'?'agency_system_user':'bisu_management'):'human_required',status:maintenance.attemptState==='retry_wait'?'retry_scheduled':maintenance.attemptState==='running'?'pending':maintenance.attemptState==='human_required'?'human_required':maintenance.unknownSince!==null?'unknown':maintenance.attemptState==='scheduled'&&maintenance.nextAttemptAt<=+now()?'due':'healthy',expiresAt:C.F.expiry(context.effective.metadata),nextAttemptAt:maintenance.nextAttemptAt,lastSuccessAt:maintenance.lastHealthyAt,lastError:maintenance.humanReason}},pending:row?pendingDto(row,input):null};
    });},
    async begin(input){gate();input=require('./metaMarketingTransactionOrder.service').pinInput(input);const state=randomBytes(32).toString('base64url');
      const row=await order.scope(input,{active:true},async({transaction,enrollment})=>{const selectedPolicy=policy(input.scopeKey),context=enrollment?await admission(input,transaction,enrollment.enrollment_id):null;if(!context)C.fail('meta_business_scope_forbidden',403);
        if(await H.findOne({...opts(transaction),where:{pending_scope_key:input.scopeKey}})||models.MetaMarketingCredentialRenewal&&await models.MetaMarketingCredentialRenewal.findOne({...opts(transaction),where:{pending_enrollment_id:context.enrollment.enrollment_id}})||models.MetaMarketingCredentialMaintenance&&await models.MetaMarketingCredentialMaintenance.findOne({...opts(transaction),where:{pending_enrollment_id:context.enrollment.enrollment_id,rotate_sent_at:{[Op.ne]:null}}}))C.fail('meta_business_busy',409);
        const old=context.enrollment,flow=await models.MetaMarketingOAuthRequest.findByPk(old.flow_id,opts(transaction));let redirectUri=flow?.redirect_uri;
        if(!redirectUri){const source=await require('./metaMarketingBusinessSource.service').createSource({models,now}).forEnrollment(old,transaction);redirectUri=source?.row.redirect_uri;}
        if(typeof redirectUri!=='string')C.fail();const id=randomUUID(),date=now(),sourceSnapshot=JSON.stringify(C.freeze(old));
        const value=C.request({handover_id:id,new_enrollment_id:id,old_enrollment_id:old.enrollment_id,pending_scope_key:old.scope_key,scope_key:old.scope_key,clinic_ids:old.clinic_ids,assets:old.assets,mapping_ids:old.mapping_ids,connection_ref:old.connection_ref,app_id:old.app_id,issuer_kind:selectedPolicy.issuerKind,issuer_business_id:selectedPolicy.issuerBusinessId,config_id:selectedPolicy.configId,graph_version:selectedPolicy.graphVersion,
          old_scope_digest:old.scope_digest,source_snapshot:sourceSnapshot,source_digest:C.hash(sourceSnapshot),scope_digest:C.hash(JSON.stringify([old.enrollment_id,context.authority.digest,old.scope_digest,old.clinic_ids,C.F.assetSetDigest(old.selected),old.app_id,selectedPolicy.issuerKind,selectedPolicy.issuerBusinessId,selectedPolicy.configId,selectedPolicy.graphVersion,'business-v2'])),asset_set_digest:C.F.assetSetDigest(old.selected),scopes:JSON.stringify(C.scopesFor(selectedPolicy.issuerKind)),state_hash:C.hash(state),
          actor_user_id:input.actorId,session_ref:input.sessionRef,session_expires_at:input.sessionExpiresAt,expected_epoch:context.effective.epoch,expected_version_id:context.effective.versionId,expected_candidate_digest:context.effective.digest,
          begin_request_id:randomUUID(),finish_request_id:randomUUID(),activate_request_id:randomUUID(),abort_request_id:randomUUID(),drain_request_id:randomUUID(),revoke_request_id:randomUUID(),redirect_uri:redirectUri,return_origin:returnOrigin,state:'begin_pending',requested_at:date,updated_at:date,expires_at:new Date(+date+600000),next_attempt_at:date,
          completed_at:null,activate_sent_at:null,retired_at:null,lease_token:null,lease_until:null,attempts:0,candidate_metadata:null,owner_receipt:null,old_grant_digest:null,code_digest:null,drain_digest:null,new_canonical_id:null,last_error:null});
        await H.create(value,{transaction,logging:false});await record(value,'meta_business_requested',transaction,input);return value;});
      try{const remote=await call(row,'begin',{handoverId:row.handover_id,flowId:row.handover_id,newEnrollmentId:row.handover_id,oldEnrollmentId:row.old_enrollment_id,expectedEpoch:Number(row.expected_epoch),expectedVersionId:row.expected_version_id,expectedCandidateDigest:row.expected_candidate_digest,assetSetDigest:row.asset_set_digest,oldScopeDigest:row.old_scope_digest,scopeDigest:row.scope_digest,clinicSetDigest:C.hash(row.clinic_ids),state,expiresAt:+row.expires_at});
        await tx(async transaction=>{const fresh=await current(row.handover_id,transaction);await assertRequest(fresh,transaction,{input,origin:true});await update(fresh,{state:'awaiting',old_grant_digest:remote.oldGrantDigest,next_attempt_at:new Date(+now()+30000)},transaction);});return {enabled:true,authorizationMode:row.issuer_kind,requestId:row.handover_id,status:'awaiting',authUrl:remote.authUrl,expiresAt:remote.expiresAt};
      }catch(error){await queueCancel(row.handover_id,C.safe(error));throw error;}
    },
    async callback({state,code,denied=false}){if(!C.STATE.test(state)||!denied&&(typeof code!=='string'||!(/^[\x21-\x7e]{1,4096}$/).test(code)))C.fail('meta_business_invalid',400);
      let row=plain(await H.findOne({where:{state_hash:C.hash(state)},raw:true,logging:false}));if(!row)C.fail('meta_oauth_state_invalid',400);row=C.request(row);const result={returnOrigin:row.return_origin,requestId:row.handover_id};
      if(denied||!enabled()){await queueCancel(row.handover_id,!enabled()?'meta_business_disabled':null);try{await reconcileId(row.handover_id);}catch{}return result;}
      if(row.code_digest!==null){if(row.code_digest!==C.hash(code))C.fail('meta_business_invalid',400);try{await reconcileId(row.handover_id);}catch{}return result;}
      let sent=false;try{row=await tx(async transaction=>{const fresh=await current(row.handover_id,transaction);await assertRequest(fresh,transaction,{origin:true});if(fresh.state!=='awaiting'||+fresh.expires_at<=+now())C.fail('meta_business_expired',409);return update(fresh,{state:'processing',code_digest:C.hash(code),next_attempt_at:now()},transaction);});
        if(!enabled()){await queueCancel(row.handover_id,'meta_business_disabled');await reconcileId(row.handover_id);return result;}sent=true;await call(row,'finish',{handoverId:row.handover_id,flowId:row.handover_id,state,code});await reconcileId(row.handover_id);
      }catch(error){if([400,401,403,409].includes(error.httpStatus)||['meta_business_candidate_rejected','meta_business_identity_mismatch'].includes(C.safe(error)))await queueCancel(row.handover_id,C.safe(error));else if(sent)await tx(async transaction=>{const fresh=await current(row.handover_id,transaction);if(!C.TERMINAL.includes(fresh.state))await update(fresh,{last_error:C.safe(error),next_attempt_at:now()},transaction);});}return result;
    },
    async confirm(input,id,{candidateDigest,clientBusinessId,subjectId,issuerKind,providerBusinessId}){gate();if(!C.HASH.test(candidateDigest)||!/^[1-9][0-9]{0,29}$/.test(subjectId||'')||!C.ISSUERS.includes(issuerKind)||(issuerKind===C.A.ISSUER?clientBusinessId!==null||!/^[1-9][0-9]{0,29}$/.test(providerBusinessId||''):providerBusinessId!==null||!/^[1-9][0-9]{0,29}$/.test(clientBusinessId||'')))C.fail('meta_business_invalid',400);
      await tx(async transaction=>{const row=await current(id,transaction);await assertRequest(row,transaction,{input,origin:true});if(!row.candidate||row.candidate.digest!==candidateDigest||(row.candidate.clientBusinessId??null)!==clientBusinessId||row.candidate.subjectId!==subjectId||row.issuer_kind!==issuerKind||C.providerBusinessId(row.candidate)!==providerBusinessId||C.F.expiry(row.candidate)<=+now())C.fail('meta_business_identity_mismatch',409);
        if(row.state==='activate_pending')return;if(row.state!=='staged')C.fail('meta_business_scope_changed',409);const next=await update(row,{state:'activate_pending',last_error:null,next_attempt_at:now()},transaction);await record(next,'meta_business_activation_requested',transaction,input);});try{await reconcileId(id);}catch{}return service.overview(input);},
    async cancel(input,id){await queueCancel(id,null,input);try{await reconcileId(id);}catch{}return service.overview(input);},
    async reconcile(input,id){await tx(async transaction=>{const row=await current(id,transaction);await scope.authorize(input,transaction);if(input.scopeKey!==row.scope_key)C.fail('meta_business_scope_forbidden',403);});try{await reconcileId(id);}catch(error){await tx(async transaction=>{const row=await current(id,transaction);if(!C.TERMINAL.includes(row.state))await update(row,{last_error:C.safe(error),next_attempt_at:new Date(+now()+30000)},transaction);});}return service.overview(input);},
    async run(){if(!enabled()||!H)return {status:'completed',skipped:true};let processed=0,failed=0;const deadline=+now()+30000,rows=await H.findAll({where:{state:{[Op.notIn]:C.TERMINAL},next_attempt_at:{[Op.lte]:now()}},order:[['next_attempt_at','ASC']],limit:10,raw:true,logging:false});for(const row of rows){if(+now()>=deadline)break;try{await reconcileId(row.handover_id);processed++;}catch(error){failed++;if([400,401,403,409].includes(error.httpStatus))await queueCancel(row.handover_id,C.safe(error));else await tx(async transaction=>{const fresh=await current(row.handover_id,transaction);if(!C.TERMINAL.includes(fresh.state))await update(fresh,{last_error:C.safe(error),next_attempt_at:new Date(+now()+60000)},transaction);});}}return {status:failed?'failed':'completed',retryable:false,processed,failed};},reconcileId
  };return service;
}
let singleton;const instance=()=>singleton||=createService({models:require('../../models'),sessions:require('./accessSession.service'),client:require('./metaMarketingOAuthClient.service').createClient()});
module.exports={createService,configurationFrom,runtimeConfiguration,safe:C.safe,...Object.fromEntries(['overview','begin','callback','confirm','cancel','reconcile'].map(name=>[name,(...args)=>instance()[name](...args)])),run:()=>process.env.RUNTIME_ROLE==='gateway'?Promise.resolve({status:'completed',skipped:true}):instance().run()};
