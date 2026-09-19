'use strict';
const {randomUUID}=require('node:crypto'),{Op}=require('sequelize'),C=require('./metaMarketingEnrollment.contract');
const plain=v=>v?.get?v.get({plain:true}):v;
const CLOSING=new Set(['meta_enrollment_disabled','meta_enrollment_scope_changed','meta_enrollment_scope_blocked','meta_enrollment_asset_revoked',
  'meta_enrollment_asset_in_use','meta_enrollment_assignment_review','meta_enrollment_identity_review','meta_oauth_scope_changed','meta_oauth_scope_forbidden',
  'meta_oauth_scope_blocked','meta_oauth_session_required','auth_email_verification_required','asset_revoked','scope_denied','credential_revoked','connection_blocked','secret_version_changed']);
const SAFE=new Set([...CLOSING,'meta_enrollment_lease_lost','meta_enrollment_prepare_uncertain','meta_enrollment_activation_uncertain','meta_enrollment_not_active',
  'meta_enrollment_invalid','meta_enrollment_scope_forbidden','meta_enrollment_busy','meta_enrollment_unavailable',
  'broker_response_invalid','broker_configuration_invalid','broker_timeout','broker_unavailable','rate_limited','audit_unavailable','outcome_unknown','provider_timeout']);
const safe=error=>SAFE.has(error?.code)?error.code:'meta_enrollment_unavailable';
const claimSql=id=>`SELECT enrollment_id FROM MetaMarketingEnrollmentRequests
  WHERE delivery_due_at <= $now AND (lease_until IS NULL OR lease_until <= $now)
  ${id?'AND enrollment_id = $id':''} ORDER BY delivery_due_at,enrollment_id LIMIT 1 FOR UPDATE SKIP LOCKED`;
function createService({models,sessions,oauth,client,now=()=>new Date(),enabled=()=>process.env.META_MARKETING_ENROLLMENT_ENABLED==='true',
  workerEnabled=()=>process.env.META_MARKETING_ENROLLMENT_WORKER_ENABLED==='true'}){
  const R=models.MetaMarketingEnrollmentRequest,scope=require('./metaMarketingOAuthScope.service').createScope({models,sessions,now});
  const authority=require('./metaMarketingEnrollmentAuthority.service').createAuthority({models,sessions,oauth,now,enabled});
  const bindings=require('./metaMarketingEnrollmentBinding.service').createBindings({models,sessions,authority,now});
  const tx=fn=>models.sequelize.transaction({isolationLevel:'REPEATABLE READ'},fn),lock=transaction=>({transaction,lock:transaction.LOCK.UPDATE,logging:false});
  const project=row=>({requestId:row.enrollment_id,flowId:row.flow_id,state:row.state,connected:row.state==='active',clinicCount:row.clinicIds.length,
    assets:row.selected,selectionDigest:row.selection_digest,mappingIds:row.mappingIds,lastError:row.last_error,cancellationConfirmed:row.state==='revoked'});
  async function current(id,transaction){
    if(!C.UUID.test(id))C.fail('meta_enrollment_invalid',400);const row=await R.findByPk(id,lock(transaction));
    if(!row)C.fail('meta_enrollment_scope_forbidden',403);return C.request(plain(row));
  }
  async function owned(row,transaction){
    const fresh=await current(row.enrollment_id,transaction);
    if(!row.lease_token||fresh.lease_token!==row.lease_token||+fresh.lease_until<=+now())C.fail('meta_enrollment_lease_lost',409);
    return fresh;
  }
  const update=async(row,changes,transaction)=>{
    await R.update(changes,{where:{enrollment_id:row.enrollment_id},transaction,logging:false});return C.request({...row,...changes});
  };
  async function access(input,id,transaction,original=false){
    await scope.authorize(input,transaction);const row=await current(id,transaction);
    if(row.scope_key!==input.scopeKey||original&&(Number(row.actor_user_id)!==input.actorId||row.session_ref!==input.sessionRef||+row.session_expires_at!==+input.sessionExpiresAt))C.fail('meta_enrollment_scope_forbidden',403);
    return row;
  }
  async function cancelLocked(row,transaction,actor){
    if(['revoke_pending','revoked'].includes(row.state))return row;
    await bindings.record(row,'meta_enrollment_cancel_requested',transaction,actor);
    await models.MetaMarketingBrokerBinding.update({state:'blocked'},{where:{enrollment_id:row.enrollment_id},transaction,logging:false});
    if(row.mappingIds.length){
      const s=bindings.scopeOf(row);
      await models.ClinicMetaAsset.update({isActive:false},{where:{id:{[Op.in]:row.mappingIds},metaConnectionId:row.meta_connection_id,
        assignmentScope:s.assignmentScope,clinicaId:s.clinicId,grupoClinicaId:s.groupId,[Op.or]:row.selected.map(a=>({assetType:a.kind,metaAssetId:a.id}))},transaction,logging:false});
    }
    return update(row,{state:'revoke_pending',updated_at:now(),next_attempt_at:now(),attempts:0,last_error:null},transaction);
  }
  async function claim(id){
    return tx(async transaction=>{
      if(id&&!C.UUID.test(id))C.fail('meta_enrollment_invalid',400);
      // Sequelize 6 ignores skipLocked for MySQL; use the real MySQL 8 clause.
      const [rows]=await models.sequelize.query(claimSql(id),
      {bind:{now:now().toISOString().slice(0,23).replace('T',' '),...(id?{id}: {})},transaction,logging:false});
      if(!rows.length)return null;const row=await current(rows[0].enrollment_id,transaction);
      return update(row,{lease_token:randomUUID(),lease_until:new Date(+now()+120000),attempts:Math.min(Number(row.attempts)+1,1000000)},transaction);
    });
  }
  async function assertWork(row){
    if(!workerEnabled())C.fail('meta_enrollment_worker_disabled');
    return tx(async transaction=>{
      const fresh=await owned(row,transaction);if(fresh.state!==row.state)C.fail('meta_enrollment_scope_changed',409);
      if(fresh.state==='active')await bindings.committed(fresh.enrollment_id,transaction);
      else if(fresh.state!=='revoke_pending')await authority.assertPending(fresh,transaction);
      return fresh;
    });
  }
  async function call(row,name){
    await assertWork(row);
    if(['prepare','activate'].includes(name))row=await tx(async transaction=>{
      const fresh=await owned(row,transaction);await authority.assertPending(fresh,transaction);
      if(fresh.state!==row.state||fresh[name+'_sent_at']!=null)C.fail('meta_enrollment_'+(name==='activate'?'activation':'prepare')+'_uncertain');
      return update(fresh,{[name+'_sent_at']:now()},transaction);
    });
    const requestId=name==='status'?randomUUID():row[name+'_request_id'];
    const payload={enrollmentId:row.enrollment_id,...(name==='prepare'?{flowId:row.flow_id,scopeDigest:row.scope_digest,candidateDigest:row.candidate_digest,assetRefs:row.selected.map(a=>a.assetRef)}:
      name==='activate'?{scopeDigest:row.scope_digest,selectionDigest:row.selection_digest}:{})};
    const response=await client.execute({requestId,operation:C.E.OPERATIONS[name],tenantRef:'clinic:'+row.clinicIds[0],connectionRef:row.connection_ref,assetRef:'meta-enroll:'+row.scope_key,payload},
      {timeoutMs:['prepare','activate'].includes(name)?30000:10000});
    if(!C.exact(response,'requestId,data,replayed')||response.requestId!==requestId||typeof response.replayed!=='boolean'||name==='status'&&response.replayed)C.fail('broker_response_invalid');
    return C.receipt(response.data,row,{states:['prepared','active','revoked'],allowUnknown:name==='status'});
  }
  const release=(row,delay,last_error=null)=>tx(async transaction=>{
    const fresh=await owned(row,transaction);return update(fresh,{lease_token:null,lease_until:null,updated_at:now(),next_attempt_at:new Date(+now()+delay),last_error},transaction);
  });
  async function withdrawn(row,remote){
    if(remote.status!=='revoked'||remote.accessBlocked!==true)C.fail('broker_response_invalid');
    return tx(async transaction=>{
      const fresh=await owned(row,transaction);if(fresh.state!=='revoke_pending')C.fail('meta_enrollment_scope_changed',409);
      C.receipt(remote,fresh,{states:['revoked']});await bindings.record(fresh,'meta_enrollment_cancelled',transaction);
      const completed=await update(fresh,{state:'revoked',revoked_at:now(),updated_at:now(),last_error:null,lease_token:null,lease_until:null},transaction);
      if(typeof oauth?.cancelAfterEnrollment!=='function')C.fail('meta_enrollment_unavailable');
      await oauth.cancelAfterEnrollment(completed,transaction);return completed;
    });
  }
  async function advance(row){
    await assertWork(row);
    if(row.state==='prepared')return release(row,30000);
    let remote=await call(row,'status');
    if(row.state==='revoke_pending')return withdrawn(row,remote.status==='revoked'?remote:await call(row,'revoke'));
    if(remote.status==='revoked'||remote.status==='active'&&remote.accessBlocked)C.fail('asset_revoked',409);
    if(row.state==='active'){
      if(remote.status!=='active')C.fail('meta_enrollment_scope_changed',409);
      return release(row,300000);
    }
    if(row.state==='prepare_pending'){
      if(remote.status==='not_found'){
        if(row.prepare_sent_at!=null)return release(row,60000,'meta_enrollment_prepare_uncertain');
        remote=await call(row,'prepare');
      }
      if(remote.status!=='prepared')C.fail('meta_enrollment_scope_changed',409);
      return tx(async transaction=>{
        const fresh=await owned(row,transaction);await authority.assertPending(fresh,transaction);
        if(fresh.state!=='prepare_pending')C.fail('meta_enrollment_scope_changed',409);
        const next=C.request({...fresh,state:'prepared',selection_digest:remote.selectionDigest,prepared_at:new Date(remote.preparedAt),updated_at:now(),
          attempts:0,next_attempt_at:new Date(+now()+30000),lease_token:null,lease_until:null,last_error:null});
        await bindings.record(next,'meta_enrollment_prepared',transaction);return update(fresh,next,transaction);
      });
    }
    if(row.state!=='activate_pending')C.fail();
    if(remote.status==='prepared'){
      // Once delivery may have begun, status is the only automatic recovery.
      // A still-prepared result is not proof that replaying activation is safe.
      if(row.activate_sent_at!=null)return release(row,60000,'meta_enrollment_activation_uncertain');
      remote=await call(row,'activate');
    }
    if(remote.status!=='active'||remote.accessBlocked)C.fail('meta_enrollment_scope_changed',409);
    return tx(async transaction=>bindings.activate(await owned(row,transaction),remote,transaction));
  }
  let running=false;
  return {
    async overview(input){return tx(async transaction=>{
      await scope.authorize(input,transaction);
      const stored=await R.findOne({...lock(transaction),where:{scope_key:input.scopeKey},order:[['requested_at','DESC'],['enrollment_id','DESC']]});
      if(!stored)return {enabled:enabled(),canSelect:enabled(),selection:null};
      const row=C.request(plain(stored));let selection=project(row);
      if(row.state==='active')try{await bindings.committed(row.enrollment_id,transaction);}
      catch(error){selection={...selection,connected:false,attentionRequired:true,lastError:safe(error)};}
      return {enabled:enabled(),canSelect:enabled()&&row.state==='revoked',selection:{...selection,
        canConfirm:enabled()&&row.state==='prepared'&&Number(row.actor_user_id)===input.actorId&&row.session_ref===input.sessionRef
          &&+row.session_expires_at===+input.sessionExpiresAt&&+row.session_expires_at>+now(),canCancel:!['revoke_pending','revoked'].includes(row.state)}};
    });},
    async cancelFromOAuth(flowId,transaction,actor){
      if(!transaction||!C.UUID.test(flowId))C.fail();
      const row=await R.findOne({...lock(transaction),where:{flow_id:flowId}});
      return row?cancelLocked(C.request(plain(row)),transaction,actor):null;
    },
    async reserve(input,flowId,refs){return project(C.request(await authority.reserve(input,flowId,refs)));},
    async status(input,id){return tx(async transaction=>{const row=await access(input,id,transaction);if(row.state==='active')await bindings.committed(id,transaction);return project(row);});},
    async confirm(input,id,selectionDigest){
      if(!C.HASH.test(selectionDigest))C.fail('meta_enrollment_invalid',400);
      return tx(async transaction=>{
        const row=await access(input,id,transaction,true);await authority.assertPending(row,transaction);
        if(row.selection_digest!==selectionDigest||!['prepared','activate_pending'].includes(row.state))C.fail('meta_enrollment_scope_changed',409);
        if(row.state==='activate_pending')return project(row);
        if(row.lease_until&&row.lease_until>now())C.fail('meta_enrollment_busy',409);
        const next={...row,state:'activate_pending',attempts:0,updated_at:now(),next_attempt_at:now(),last_error:null};
        await bindings.record(next,'meta_enrollment_activation_requested',transaction);return project(await update(row,next,transaction));
      });
    },
    async cancel(input,id){return tx(async transaction=>project(await cancelLocked(await access(input,id,transaction),transaction,{actorId:input.actorId,sessionRef:input.sessionRef})));},
    async run({enrollmentId}={}){
      if(!workerEnabled()||running)return {status:'completed',skipped:true,reason:'meta_enrollment_worker_disabled_or_busy'};
      running=true;let advanced=0,failed=0,cancelled=0;const deadline=+now()+30000;
      try{
        for(let n=0;n<(enrollmentId?1:10)&&+now()<deadline&&workerEnabled();n++){
          const row=await claim(enrollmentId);if(!row)break;
          try{await advance(row);advanced++;}
          catch(error){
            failed++;const code=safe(error);if(code==='meta_enrollment_lease_lost')continue;
            try{
              if(row.state!=='revoke_pending'&&(CLOSING.has(code)||[401,403,409].includes(error.httpStatus))){
                const pending=await tx(async transaction=>cancelLocked(await owned(row,transaction),transaction));cancelled++;
                await release(pending,0,code);
              }else await release(row,Math.min(3600000,1000*2**Math.min(Number(row.attempts),12)),code);
            }catch(secondary){if(secondary.code!=='meta_enrollment_lease_lost')throw secondary;}
          }
        }
        return {status:failed?'failed':'completed',retryable:false,advanced,failed,cancelled};
      }finally{running=false;}
    },
  };
}
let singleton;
const instance=()=>singleton||=createService({models:require('../../models'),sessions:require('./accessSession.service'),
  oauth:require('./metaMarketingOAuth.service'),client:require('./metaMarketingOAuthClient.service').createClient()});
module.exports={createService,safe,claimSql,...Object.fromEntries(['overview','reserve','status','confirm','cancel'].map(k=>[k,(...args)=>instance()[k](...args)])),
  run:()=>process.env.RUNTIME_ROLE==='gateway'?Promise.resolve({status:'completed',skipped:true,reason:'gateway_runtime'}):
    process.env.META_MARKETING_ENROLLMENT_WORKER_ENABLED==='true'?instance().run():Promise.resolve({status:'completed',skipped:true,reason:'meta_enrollment_worker_disabled'})};
