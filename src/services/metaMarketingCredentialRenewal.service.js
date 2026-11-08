'use strict';
const {randomUUID,randomBytes}=require('node:crypto'),{Op}=require('sequelize');
const C=require('./metaMarketingCredentialRenewal.contract'),{fromRenewal}=require('../../services/platform-audit/src/meta-credential-renewal-event');
const plain=value=>value?.get?value.get({plain:true}):value;
const actor=row=>({scopeKey:row.scope_key,actorId:Number(row.actor_user_id),sessionRef:row.session_ref,sessionExpiresAt:row.session_expires_at});
function createService({models,sessions,client,now=()=>new Date(),enabled=()=>process.env.META_MARKETING_CREDENTIAL_RENEWAL_ENABLED==='true',returnOrigin=C.frontendOrigin(),audit:providedAudit}={}){
  const R=models.MetaMarketingCredentialRenewal,P=models.MetaMarketingEffectiveCredential;
  const credentials=C.F.createEffectiveCredentials({models,now}),scope=require('./metaMarketingOAuthScope.service').createScope({models,sessions,now});
  const bindings=require('./metaMarketingEnrollmentBinding.service').createBindings({models,sessions,now});
  const audit=providedAudit||require('./platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const tx=work=>models.sequelize.transaction({isolationLevel:'REPEATABLE READ'},work);
  const order=require('./metaMarketingTransactionOrder.service').createOrder({models,authorize:scope.authorize,unavailable:()=>C.fail('meta_renewal_unavailable',503)});
  const lock=transaction=>({transaction,lock:transaction.LOCK.UPDATE,raw:true,logging:false});
  const gate=()=>{if(!enabled())C.fail('meta_renewal_disabled',503);if(!R||!P)C.fail('meta_renewal_unavailable',503);};
  async function record(row,reason,transaction,input){
    const health=await audit.health(now(),{includeUnresolved:false,transaction});
    if(!Number.isSafeInteger(health.pending)||health.pending>=10000||!Number.isFinite(health.oldestAgeSeconds)||health.oldestAgeSeconds>=3600)C.fail('audit_unavailable');
    await audit.append(fromRenewal(row,reason,{now:now(),...(input?{actorId:input.actorId,sessionRef:input.sessionRef}:{})}),{transaction});
  }
  async function current(id,transaction){
    if(!C.UUID.test(id))C.fail('meta_renewal_invalid',400);
    const observed=plain(await R.findByPk(id,{transaction,raw:true,logging:false}));if(!observed)C.fail('meta_renewal_scope_forbidden',403);
    // Enrollment is the common lock for begin, pointer CAS, expiry health and
    // withdrawal. Never acquire the pending-request lock before that grant.
    await models.MetaMarketingEnrollmentRequest.findByPk(observed.enrollment_id,lock(transaction));
    const row=plain(await R.findByPk(id,lock(transaction)));if(!row||row.enrollment_id!==observed.enrollment_id)C.fail('meta_renewal_scope_forbidden',403);return C.request(row);
  }
  async function update(row,patch,transaction){
    const state=patch.state??row.state,changes={...patch,updated_at:now(),pending_enrollment_id:C.TERMINAL.includes(state)?null:row.enrollment_id};
    const [changed]=await R.update(changes,{where:{renewal_id:row.renewal_id,state:row.state,lease_token:row.lease_token},transaction,logging:false});
    if(changed!==1)C.fail('meta_renewal_busy',409);return C.request({...row,...changes});
  }
  async function admission(input,transaction,enrollmentId=null){
    let raw;
    if(enrollmentId)raw=await models.MetaMarketingEnrollmentRequest.findByPk(enrollmentId,lock(transaction));
    else raw=await models.MetaMarketingEnrollmentRequest.findOne({...lock(transaction),where:{scope_key:input.scopeKey,state:'active'},order:[['requested_at','DESC'],['enrollment_id','DESC']]});
    // Human callers preauthorize in a separate transaction. Match the reader's
    // enrollment -> clinic order, then repeat current session/email/WRITE checks
    // before inspecting the row or loading assets, even when no row was found.
    if(input)await scope.authorize(input,transaction);
    if(!raw)return null;const enrollment=require('./metaMarketingEnrollment.contract').request(plain(raw));
    if(enrollment.state!=='active'||input&&enrollment.scope_key!==input.scopeKey)C.fail('meta_renewal_scope_forbidden',403);
    // Business credentials have their own consent and maintenance protocol.
    // Never send SYSTEM_USER through the legacy USER code-exchange family.
    if(models.MetaMarketingBusinessHandover&&await models.MetaMarketingBusinessHandover.findByPk(enrollment.enrollment_id,lock(transaction)))return null;
    // This internal mode ignores credential age only. It keeps every grant,
    // snapshot, asset, revocation, canonical identity and clinic membership fence.
    const authority=await bindings.committed(enrollment.enrollment_id,transaction,{allowExpiredCredential:true});
    const flow=plain(await models.MetaMarketingOAuthRequest.findByPk(enrollment.flow_id,lock(transaction)));
    const slot=C.slot(plain(await models.MetaMarketingOAuthSlot.findByPk(enrollment.scope_key,lock(transaction))));
    if(slot.state!=='active'||+slot.expires_at<=+now()||slot.connection_ref!==enrollment.connection_ref||slot.app_id!==enrollment.app_id
      ||slot.clinic_ids!==enrollment.clinic_ids||slot.scopes!==flow.scopes||slot.redirect_uri!==flow.redirect_uri)C.fail('meta_renewal_scope_changed',409);
    const effective=await credentials.resolve(enrollment,flow,transaction,{allowExpired:true});return {enrollment,flow,slot,effective,authority};
  }
  async function assertRequest(row,transaction,{input=null,requireOrigin=false,checkVersion=true}={}){
    if(input){await scope.authorize(input,transaction);if(input.scopeKey!==row.scope_key||Number(input.actorId)!==Number(row.actor_user_id))C.fail('meta_renewal_scope_forbidden',403);}
    if(requireOrigin){
      const origin=input||actor(row);
      if(origin.sessionRef!==row.session_ref||+origin.sessionExpiresAt<+row.session_expires_at)C.fail('meta_renewal_session_required',409);
      try{await scope.authorize(actor(row),transaction);}catch(error){if(error.httpStatus===401)C.fail('meta_renewal_session_required',409);throw error;}
    }
    const context=await admission(null,transaction,row.enrollment_id);if(!context)C.fail('meta_renewal_scope_changed',409);
    const {enrollment,slot,effective}=context;
    if(['scope_key','clinic_ids','connection_ref','app_id','meta_user_id','assets','scope_digest'].some(key=>row[key]!==enrollment[key])
      ||Number(row.meta_connection_id)!==Number(enrollment.meta_connection_id)||C.slotDigest(slot)!==row.slot_digest)C.fail('meta_renewal_scope_changed',409);
    if(checkVersion&&(effective.epoch!==Number(row.expected_epoch)||effective.versionId!==row.expected_version_id||effective.digest!==row.expected_candidate_digest))C.fail('meta_renewal_version_changed',409);
    return context;
  }
  async function call(row,name,payload){
    const requestId=name==='status'?randomUUID():row[name+'_request_id'];
    const command={requestId,operation:C.U.OPERATIONS[name],tenantRef:'clinic:'+row.clinicIds[0],connectionRef:row.connection_ref,assetRef:'meta-enroll:'+row.scope_key,payload};
    const response=await client.execute(command,{timeoutMs:['finish','activate'].includes(name)?30000:10000});
    if(!C.exact(response,'requestId,data,replayed')||response.requestId!==requestId||typeof response.replayed!=='boolean'||name==='status'&&response.replayed)C.fail('broker_response_invalid');
    if(name!=='begin')return C.receipt(response.data,row,{allowAbortedVersionDrift:name==='abort'});
    const value=response.data;
    if(!C.exact(value,'renewalId,flowId,enrollmentId,authUrl,expiresAt')||value.renewalId!==row.renewal_id||value.flowId!==row.renewal_id
      ||value.enrollmentId!==row.enrollment_id||value.expiresAt!==+row.expires_at)C.fail('broker_response_invalid');
    let url;try{url=new URL(value.authUrl);}catch{C.fail('broker_response_invalid');}
    const expected={client_id:row.app_id,redirect_uri:row.redirect_uri,response_type:'code',scope:row.scopeValues.join(','),state:payload.state};
    if(url.origin!=='https://www.facebook.com'||url.pathname!=='/v24.0/dialog/oauth'||url.username||url.password||url.hash
      ||[...url.searchParams.keys()].sort().join(',')!==Object.keys(expected).sort().join(',')||Object.entries(expected).some(([key,value])=>url.searchParams.get(key)!==value))C.fail('broker_response_invalid');
    return value;
  }
  const pendingDto=(row,input)=>({requestId:row.renewal_id,status:row.state,candidateReady:row.state==='staged',candidateDigest:row.candidate?.digest??null,
    candidateExpiresAt:row.candidate?.expiresAt??null,candidateDataAccessExpiresAt:row.candidate?.dataAccessExpiresAt??null,
    canConfirm:enabled()&&row.state==='staged'&&Number(row.actor_user_id)===input.actorId&&row.session_ref===input.sessionRef
      &&+input.sessionExpiresAt>=+row.session_expires_at&&+row.session_expires_at>+now()&&(C.F.expiry(row.candidate)===null||C.F.expiry(row.candidate)>+now()),
    canCancel:!C.TERMINAL.includes(row.state),lastError:row.last_error});
  async function finishCancelled(row,remote,transaction){
    if(C.TERMINAL.includes(row.state))return row;
    const rejected=row.last_error&&['meta_renewal_candidate_rejected','meta_renewal_identity_mismatch','meta_renewal_assets_insufficient','meta_renewal_expired','meta_renewal_version_changed','meta_renewal_scope_changed'].includes(row.last_error);
    const next=await update(row,{state:rejected?'rejected':'cancelled',owner_receipt:JSON.stringify(remote),completed_at:now(),lease_token:null,lease_until:null},transaction);
    await record(next,rejected?'meta_credential_renewal_rejected':'meta_credential_renewal_cancelled',transaction);return next;
  }
  async function apply(row,remote,transaction){
    if(row.state==='active')return row;
    if(!(['activate_pending','cancel_pending'].includes(row.state)&&row.activate_sent_at)||!remote.activationApplied||remote.status!=='active'||!row.candidate
      ||remote.candidate.digest!==row.candidate.digest)C.fail('broker_response_invalid');
    let context;
    try{context=await assertRequest(row,transaction);}catch(error){
      if(![403,409].includes(error.httpStatus))throw error;
      // A concurrent explicit withdrawal wins over credential replacement.
      // Retain the owner's receipt for reconciliation; never restore the grant.
      const rejected=await update(row,{state:'rejected',owner_receipt:JSON.stringify(remote),last_error:'meta_renewal_scope_changed',completed_at:now(),lease_token:null,lease_until:null},transaction);
      await record(rejected,'meta_credential_renewal_rejected',transaction);return rejected;
    }
    const checked=C.F.candidate({versionId:remote.effectiveCredential.versionId,
      digest:remote.effectiveCredential.digest,...remote.effectiveCredential.metadata},row,row.scopeValues);
    if(C.F.expiry(checked)!==null&&C.F.expiry(checked)<=+now())C.fail('meta_renewal_expired',409);
    const ownerReceipt=JSON.stringify(remote),value={enrollment_id:row.enrollment_id,renewal_id:row.renewal_id,epoch:Number(row.expected_epoch)+1,version_id:checked.versionId,
      candidate_digest:checked.digest,candidate_metadata:JSON.stringify(checked),owner_receipt_digest:C.hash(ownerReceipt),activated_at:now(),last_error:null,last_error_at:null,unknown_since:null,last_healthy_at:now()};
    const pointer=plain(await P.findByPk(row.enrollment_id,lock(transaction)));
    if(pointer){const [changed]=await P.update(value,{where:{enrollment_id:row.enrollment_id,epoch:Number(row.expected_epoch),version_id:row.expected_version_id,candidate_digest:row.expected_candidate_digest},transaction,logging:false});if(changed!==1)C.fail('meta_renewal_version_changed',409);}
    else{if(context.effective.epoch!==0)C.fail('meta_renewal_version_changed',409);await P.create(value,{transaction,logging:false});}
    const next=await update(row,{state:'active',owner_receipt:ownerReceipt,completed_at:now(),lease_token:null,lease_until:null,last_error:null},transaction);
    await record(next,'meta_credential_renewal_activated',transaction);return next;
  }
  async function queueCancel(id,code=null,input=null){return tx(async transaction=>{
    const row=await current(id,transaction);if(C.TERMINAL.includes(row.state))return row;
    if(input){await scope.authorize(input,transaction);if(input.scopeKey!==row.scope_key||input.actorId!==Number(row.actor_user_id))C.fail('meta_renewal_scope_forbidden',403);}
    const next=await update(row,{state:'cancel_pending',last_error:code,next_attempt_at:now(),lease_token:null,lease_until:null},transaction);
    if(row.state!=='cancel_pending')await record(next,'meta_credential_renewal_cancel_requested',transaction,input);return next;
  });}
  async function reconcileId(id){
    let row=await tx(transaction=>current(id,transaction));if(C.TERMINAL.includes(row.state))return row;
    // Closing admission also stops a queued exchange/activation. Abort still
    // returns a previously applied CAS so its receipt can be acknowledged.
    if(!enabled()&&row.state!=='cancel_pending')row=await queueCancel(id,'meta_renewal_disabled');
    // Status/abort never need an old login to resolve an already-authorized CAS.
    let remote=await call(row,row.state==='cancel_pending'?'abort':'status',{renewalId:id});
    if(remote.activationApplied)return tx(async transaction=>apply(await current(id,transaction),remote,transaction));
    if(row.state==='cancel_pending'||row.state==='begin_pending'){
      if(!['aborted','not_found','rejected','interrupted'].includes(remote.status))remote=await call(row,'abort',{renewalId:id});
      if(remote.activationApplied)return tx(async transaction=>apply(await current(id,transaction),remote,transaction));
      return tx(async transaction=>finishCancelled(await current(id,transaction),remote,transaction));
    }
    if(['aborted','rejected','interrupted','not_found'].includes(remote.status)){
      return tx(async transaction=>{const currentRow=await current(id,transaction);if(C.TERMINAL.includes(currentRow.state))return currentRow;const next=await update(currentRow,{state:'rejected',last_error:'meta_renewal_candidate_rejected',owner_receipt:JSON.stringify(remote),completed_at:now(),lease_token:null,lease_until:null},transaction);await record(next,'meta_credential_renewal_rejected',transaction);return next;});
    }
    if(row.state==='activate_pending'){
      const send=await tx(async transaction=>{const currentRow=await current(id,transaction);if(currentRow.state!=='activate_pending')return false;await assertRequest(currentRow,transaction,{requireOrigin:true});if(!currentRow.activate_sent_at)await update(currentRow,{activate_sent_at:now()},transaction);return true;});
      if(!send)return tx(transaction=>current(id,transaction));
      if(!enabled()){await queueCancel(id,'meta_renewal_disabled');return reconcileId(id);}
      remote=await call(row,'activate',{renewalId:id,enrollmentId:row.enrollment_id,expectedEpoch:Number(row.expected_epoch),expectedVersionId:row.expected_version_id,
        expectedCandidateDigest:row.expected_candidate_digest,candidateVersionId:id,candidateDigest:row.candidate.digest});
      return tx(async transaction=>apply(await current(id,transaction),remote,transaction));
    }
    return tx(async transaction=>{
      const currentRow=await current(id,transaction);
      if(C.TERMINAL.includes(currentRow.state)||['activate_pending','cancel_pending'].includes(currentRow.state))return currentRow;
      await assertRequest(currentRow,transaction,{requireOrigin:true});
      if(remote.status==='staged'){
        const candidate=C.F.candidate({versionId:remote.candidate.versionId,digest:remote.candidate.digest,...remote.candidate.metadata},currentRow,currentRow.scopeValues);
        if(C.F.expiry(candidate)!==null&&C.F.expiry(candidate)<=+now())C.fail('meta_renewal_expired',409);
        if(currentRow.candidate_metadata!==null&&currentRow.candidate_metadata!==JSON.stringify(candidate))C.fail('broker_response_invalid');
        const next=await update(currentRow,{state:'staged',candidate_metadata:JSON.stringify(candidate),grant_digest:remote.grantDigest,owner_receipt:JSON.stringify(remote),last_error:null,next_attempt_at:new Date(+now()+30000),lease_token:null,lease_until:null},transaction);
        if(currentRow.state!=='staged')await record(next,'meta_credential_candidate_staged',transaction);return next;
      }
      if(+currentRow.expires_at<=+now())C.fail('meta_renewal_expired',409);
      return update(currentRow,{state:remote.status==='processing'?'processing':'awaiting',grant_digest:remote.grantDigest,owner_receipt:JSON.stringify(remote),next_attempt_at:new Date(+now()+30000),lease_token:null,lease_until:null},transaction);
    });
  }
  const service={
    async overview(input){
      if(!enabled())return {enabled:false,canRenew:false,credential:null,pending:null};
      return order.scope(input,{active:true},async({transaction,enrollment,input})=>{
        const context=enrollment?await admission(input,transaction,enrollment.enrollment_id):null;if(!context)return {enabled:true,canRenew:false,credential:null,pending:null};
        const pending=await R.findOne({...lock(transaction),where:{pending_enrollment_id:context.enrollment.enrollment_id}});
        const latest=plain(pending||await R.findOne({...lock(transaction),where:{enrollment_id:context.enrollment.enrollment_id},order:[['requested_at','DESC'],['renewal_id','DESC']]}));
        const row=latest?C.request(latest):null,value=context.effective;
        return {enabled:true,canRenew:!row||C.TERMINAL.includes(row.state),credential:{epoch:value.epoch,versionId:value.versionId,expiresAt:value.metadata.expiresAt,
          dataAccessExpiresAt:value.metadata.dataAccessExpiresAt,expired:value.expired,requiresRenewal:value.requiresRenewal,healthKind:value.healthKind,lastError:value.lastError},pending:row?pendingDto(row,input):null};
      });
    },
    async begin(input){
      gate();input=require('./metaMarketingTransactionOrder.service').pinInput(input);const state=randomBytes(32).toString('base64url');
      const row=await order.scope(input,{active:true},async({transaction,enrollment:stored})=>{
        const context=stored?await admission(input,transaction,stored.enrollment_id):null;if(!context)C.fail('meta_renewal_scope_forbidden',403);
        const {enrollment,slot,effective}=context;
        if(await R.findOne({...lock(transaction),where:{pending_enrollment_id:enrollment.enrollment_id}}))C.fail('meta_renewal_busy',409);
        const date=now(),id=randomUUID(),expires=new Date(Math.min(+date+600000,+input.sessionExpiresAt,+slot.expires_at));
        if(+expires<=+date)C.fail('meta_renewal_session_required',401);
        const value=C.request({renewal_id:id,enrollment_id:enrollment.enrollment_id,pending_enrollment_id:enrollment.enrollment_id,scope_key:enrollment.scope_key,
          clinic_ids:enrollment.clinic_ids,connection_ref:enrollment.connection_ref,app_id:enrollment.app_id,meta_user_id:enrollment.meta_user_id,meta_connection_id:Number(enrollment.meta_connection_id),
          scopes:slot.scopes,redirect_uri:slot.redirect_uri,return_origin:returnOrigin,scope_digest:enrollment.scope_digest,slot_digest:C.slotDigest(slot),assets:enrollment.assets,
          asset_set_digest:C.F.assetSetDigest(enrollment.selected),expected_epoch:effective.epoch,expected_version_id:effective.versionId,expected_candidate_digest:effective.digest,
          state_hash:C.hash(state),actor_user_id:input.actorId,session_ref:input.sessionRef,session_expires_at:input.sessionExpiresAt,
          begin_request_id:randomUUID(),finish_request_id:randomUUID(),activate_request_id:randomUUID(),abort_request_id:randomUUID(),requested_at:date,expires_at:expires,updated_at:date,next_attempt_at:date,
          state:'begin_pending',candidate_metadata:null,owner_receipt:null,grant_digest:null,code_digest:null,last_error:null,lease_token:null,lease_until:null,completed_at:null,activate_sent_at:null,attempts:0});
        await R.create(value,{transaction,logging:false});await record(value,'meta_credential_renewal_requested',transaction,input);return value;
      });
      try{
        const remote=await call(row,'begin',{renewalId:row.renewal_id,flowId:row.renewal_id,enrollmentId:row.enrollment_id,expectedEpoch:Number(row.expected_epoch),expectedVersionId:row.expected_version_id,
          expectedCandidateDigest:row.expected_candidate_digest,assetSetDigest:row.asset_set_digest,scopeDigest:row.scope_digest,clinicSetDigest:C.hash(row.clinic_ids),state,expiresAt:+row.expires_at});
        await tx(async transaction=>{const currentRow=await current(row.renewal_id,transaction);await assertRequest(currentRow,transaction,{input,requireOrigin:true});await update(currentRow,{state:'awaiting',next_attempt_at:new Date(+now()+30000)},transaction);});
        return {enabled:true,requestId:row.renewal_id,status:'awaiting',authUrl:remote.authUrl,expiresAt:remote.expiresAt};
      }catch(error){await queueCancel(row.renewal_id,C.safe(error));throw error;}
    },
    async callback({state,code,denied=false}){
      if(!C.STATE.test(state)||!denied&&(typeof code!=='string'||!(/^[\x21-\x7e]{1,4096}$/).test(code)))C.fail('meta_renewal_invalid',400);
      let row=plain(await R.findOne({where:{state_hash:C.hash(state)},raw:true,logging:false}));if(!row)C.fail('meta_oauth_state_invalid',400);row=C.request(row);
      const result={returnOrigin:row.return_origin,requestId:row.renewal_id};
      if(!enabled()){await queueCancel(row.renewal_id,'meta_renewal_disabled');try{await reconcileId(row.renewal_id);}catch{}return result;}
      if(denied){await queueCancel(row.renewal_id);try{await reconcileId(row.renewal_id);}catch{}return result;}
      if(row.code_digest!==null){if(row.code_digest!==C.hash(code))C.fail('meta_renewal_invalid',400);try{await reconcileId(row.renewal_id);}catch{}return result;}
      let mayExchange=false;
      try{
        row=await tx(async transaction=>{const currentRow=await current(row.renewal_id,transaction);await assertRequest(currentRow,transaction,{requireOrigin:true});
          if(currentRow.state!=='awaiting'||+currentRow.expires_at<=+now())C.fail('meta_renewal_expired',409);
          mayExchange=true;return update(currentRow,{state:'processing',code_digest:C.hash(code),next_attempt_at:now()},transaction);});
        if(!enabled()){await queueCancel(row.renewal_id,'meta_renewal_disabled');await reconcileId(row.renewal_id);return result;}
        await call(row,'finish',{renewalId:row.renewal_id,flowId:row.renewal_id,state,code});await reconcileId(row.renewal_id);
      }catch(error){
        if([400,401,403,409].includes(error.httpStatus)||['meta_renewal_candidate_rejected','meta_renewal_assets_insufficient','meta_renewal_identity_mismatch'].includes(C.safe(error)))await queueCancel(row.renewal_id,C.safe(error));
        else if(mayExchange)await tx(async transaction=>{const currentRow=await current(row.renewal_id,transaction);await update(currentRow,{last_error:C.safe(error),next_attempt_at:now()},transaction);});
      }
      return result;
    },
    async confirm(input,id,candidateDigest){
      gate();if(!C.HASH.test(candidateDigest))C.fail('meta_renewal_invalid',400);
      await tx(async transaction=>{const row=await current(id,transaction);await assertRequest(row,transaction,{input,requireOrigin:true});
        if(row.state==='activate_pending'&&row.candidate?.digest===candidateDigest)return;
        if(row.state!=='staged'||row.candidate?.digest!==candidateDigest||C.F.expiry(row.candidate)!==null&&C.F.expiry(row.candidate)<=+now())C.fail('meta_renewal_expired',409);
        const next=await update(row,{state:'activate_pending',last_error:null,next_attempt_at:now()},transaction);await record(next,'meta_credential_renewal_activation_requested',transaction,input);});
      try{await reconcileId(id);}catch{}return service.overview(input);
    },
    async cancel(input,id){await queueCancel(id,null,input);try{await reconcileId(id);}catch{}return service.overview(input);},
    async reconcile(input,id){await tx(async transaction=>{const row=await current(id,transaction);await scope.authorize(input,transaction);if(row.scope_key!==input.scopeKey)C.fail('meta_renewal_scope_forbidden',403);});try{await reconcileId(id);}catch(error){await tx(async transaction=>{const row=await current(id,transaction);if(!C.TERMINAL.includes(row.state))await update(row,{last_error:C.safe(error),next_attempt_at:new Date(+now()+30000)},transaction);});}return service.overview(input);},
    async run(){
      if(!R||!enabled())return {status:'completed',skipped:true};let processed=0,failed=0;
      const deadline=+now()+30000,rows=await R.findAll({where:{state:{[Op.notIn]:C.TERMINAL},next_attempt_at:{[Op.lte]:now()}},order:[['next_attempt_at','ASC']],limit:10,raw:true,logging:false});
      for(const raw of rows){if(+now()>=deadline)break;try{await reconcileId(raw.renewal_id);processed++;}catch(error){failed++;const code=C.safe(error);
        if([400,401,403,409].includes(error.httpStatus))try{await queueCancel(raw.renewal_id,code);}catch{}
        else await tx(async transaction=>{const row=await current(raw.renewal_id,transaction);if(!C.TERMINAL.includes(row.state))await update(row,{last_error:code,next_attempt_at:new Date(+now()+60000),attempts:Number(row.attempts)+1},transaction);});
      }}return {status:failed?'failed':'completed',retryable:false,processed,failed};
    },
    reconcileId
  };return service;
}
let singleton;const instance=()=>singleton||=createService({models:require('../../models'),sessions:require('./accessSession.service'),client:require('./metaMarketingOAuthClient.service').createClient()});
module.exports={createService,safe:C.safe,...Object.fromEntries(['overview','begin','callback','confirm','cancel','reconcile'].map(name=>[name,(...args)=>instance()[name](...args)])),
  run:()=>process.env.RUNTIME_ROLE==='gateway'||process.env.META_MARKETING_CREDENTIAL_RENEWAL_ENABLED!=='true'?Promise.resolve({status:'completed',skipped:true}):instance().run()};
