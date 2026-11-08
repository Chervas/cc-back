'use strict';
const {randomUUID}=require('node:crypto'),{Op}=require('sequelize');
const C=require('./metaMarketingBusiness.contract'),M=require('../../services/integrations-broker/src/meta-marketing-credential-maintenance-contract');
const plain=row=>row?.get?row.get({plain:true}):row;
const DAY=86400000,START=14*DAY,SAFETY=3*DAY,HEALTH_INTERVAL=21600000,BACKOFF=[3600000,7200000,14400000,28800000,DAY];
const TERMINAL=['succeeded','failed','human_required'];
function createMaintenance({models,client,now=()=>new Date(),enabled=()=>process.env.META_MARKETING_BUSINESS_MAINTENANCE_ENABLED==='true',audit:providedAudit}={}){
  const T=models.MetaMarketingCredentialMaintenance,P=models.MetaMarketingEffectiveCredential,R=models.MetaMarketingEnrollmentRequest;
  const credentials=C.F.createEffectiveCredentials({models,now}),bindings=require('./metaMarketingEnrollmentBinding.service').createBindings({models,now});
  const tx=work=>models.sequelize.transaction({isolationLevel:'REPEATABLE READ'},work),opts=transaction=>({raw:true,logging:false,...(transaction?{transaction,lock:transaction.LOCK.UPDATE}:{})});
  const order=require('./metaMarketingTransactionOrder.service').createOrder({models,unavailable:()=>C.fail('meta_business_unavailable',503)});
  const audit=providedAudit||require('./platformAudit.repository').createRepository(models.PlatformAuditEvent);
  async function record(row,enrollment,reason,transaction){
    const health=await audit.health(now(),{transaction,includeUnresolved:false});if(!Number.isSafeInteger(health.pending)||health.pending>=10000||!Number.isFinite(health.oldestAgeSeconds)||health.oldestAgeSeconds>=3600)C.fail('audit_unavailable');
    await audit.append(require('../../services/platform-audit/src/meta-business-continuity-event').fromMaintenance(row,enrollment,reason,{now:now()}),{transaction});
  }
  async function context(enrollment,transaction){
    const business=await require('./metaMarketingBusinessSource.service').createSource({models,now}).forEnrollment(enrollment,transaction);
    if(!business)return null;const value=await credentials.resolve(enrollment,business.flow,transaction,{allowExpired:true});return {business,value};
  }
  async function getMaintenanceStatus(enrollmentInput,{transaction}={}){
    const enrollment=plain(enrollmentInput),health=await credentials.getCredentialStatus(enrollment,{transaction});
    const business=health.tokenType==='SYSTEM_USER',row=business&&T?plain(await T.findOne({...opts(transaction),where:{enrollment_id:enrollment.enrollment_id,expected_epoch:health.epoch,expected_version_id:health.versionId},order:[['requested_at','DESC'],['maintenance_id','DESC']]})):null;
    const humanReason=health.healthKind==='permission_lost'?'permissions_lost':health.expired?'credential_expired':row?.state==='human_required'?'authorization_required':row?.state==='failed'?'automatic_renewal_failed':null;
    const unknown=health.unknownSince??(row?.unknown_since?+new Date(row.unknown_since):row?.health_next_at&&+new Date(row.health_next_at)<=+now()?+new Date(row.health_next_at):null);
    return {enrollmentId:enrollment.enrollment_id,epoch:health.epoch,versionId:health.versionId,mechanism:business?(health.issuerKind===C.A.ISSUER?'agency_system_user':'business_api'):'user_legacy',automaticSupported:business,
      attemptState:humanReason?'human_required':row?.state??'idle',humanReason,lastAttemptAt:row?.last_attempt_at?+new Date(row.last_attempt_at):null,nextAttemptAt:row?.next_attempt_at&&!TERMINAL.includes(row.state)?+new Date(row.next_attempt_at):null,
      unknownSince:unknown!==null&&health.lastHealthyAt!==null&&health.lastHealthyAt>unknown?null:unknown,lastHealthyAt:health.lastHealthyAt??(row?.last_healthy_at?+new Date(row.last_healthy_at):null)};
  }
  async function schedule(enrollmentInput,{transaction}={}){
    const enrollment=plain(enrollmentInput);if(!T||enrollment.state!=='active')return null;
    const source=await context(enrollment,transaction);if(!source)return null;const {value}=source;
    const existing=plain(await T.findOne({...opts(transaction),where:{enrollment_id:enrollment.enrollment_id,expected_epoch:value.epoch,expected_version_id:value.versionId},order:[['requested_at','DESC']]}));if(existing)return existing;
    const date=now(),id=randomUUID(),row={maintenance_id:id,enrollment_id:enrollment.enrollment_id,pending_enrollment_id:enrollment.enrollment_id,rotate_request_id:randomUUID(),expected_epoch:value.epoch,expected_version_id:value.versionId,expected_candidate_digest:value.digest,
      state:'scheduled',requested_at:date,updated_at:date,next_attempt_at:new Date(Math.max(+date,C.F.expiry(value.metadata)-START)),window_started_at:date,last_attempt_at:null,last_healthy_at:value.lastHealthyAt?new Date(value.lastHealthyAt):null,unknown_since:null,completed_at:null,lease_token:null,lease_until:null,rotate_sent_at:null,last_error:null,attempts:0,candidate_metadata:null,owner_receipt:null,
      health_metadata:null,last_health_at:null,health_next_at:new Date(+date+HEALTH_INTERVAL),last_health_error:null};
    await T.create(row,{transaction,logging:false});return row;
  }
  async function requestTx(id,work){
    const observed=plain(await T.findByPk(id,{attributes:['maintenance_id','enrollment_id'],raw:true,logging:false}));if(!observed)C.fail();
    const prepared=await order.prepareEnrollment(observed.enrollment_id);if(!prepared)C.fail('meta_business_unavailable',503);
    return tx(async transaction=>{
      await order.lockPrepared(prepared,transaction);
      const enrollment=plain(await R.findByPk(observed.enrollment_id,opts(transaction))),row=plain(await T.findByPk(id,opts(transaction)));
      if(!row||!enrollment||row.enrollment_id!==enrollment.enrollment_id||row.enrollment_id!==observed.enrollment_id)C.fail('meta_business_unavailable',503);
      return work({row,enrollment},transaction);
    });
  }
  async function update(row,patch,transaction){
    const state=patch.state??row.state,changes={...patch,updated_at:now(),pending_enrollment_id:TERMINAL.includes(state)?null:row.enrollment_id};
    const [count]=await T.update(changes,{where:{maintenance_id:row.maintenance_id,state:row.state,lease_token:row.lease_token},transaction,logging:false});if(count!==1)C.fail('meta_business_busy',409);return {...row,...changes};
  }
  function receipt(value,row,enrollment,source){
    if(!C.exact(value,'maintenanceId,enrollmentId,status,effectiveCredential,candidate,activationApplied')||value.maintenanceId!==row.maintenance_id||!M.STATES.includes(value.status)||typeof value.activationApplied!=='boolean')C.fail('broker_response_invalid');
    if(value.status==='not_found'){if(value.enrollmentId!==null||value.effectiveCredential!==null||value.candidate!==null||value.activationApplied)C.fail('broker_response_invalid');return value;}
    if(value.enrollmentId!==row.enrollment_id||!C.exact(value.effectiveCredential,'epoch,versionId,digest,metadata'))C.fail('broker_response_invalid');
    const pin={...C.pin(source.business.row),subjectId:enrollment.meta_user_id,systemUserId:source.value.metadata.systemUserId,clientBusinessId:source.value.metadata.clientBusinessId};
    const effective=C.candidate({versionId:value.effectiveCredential.versionId,digest:value.effectiveCredential.digest,...value.effectiveCredential.metadata},pin);
    if(value.candidate!==null){if(!C.exact(value.candidate,'versionId,digest,metadata')||value.candidate.versionId!==row.maintenance_id)C.fail('broker_response_invalid');C.candidate({versionId:value.candidate.versionId,digest:value.candidate.digest,...value.candidate.metadata},pin);}
    if(value.activationApplied){if(value.status!=='active'||!value.candidate||value.effectiveCredential.epoch!==Number(row.expected_epoch)+1||effective.versionId!==row.maintenance_id||effective.digest!==value.candidate.digest||JSON.stringify(value.effectiveCredential.metadata)!==JSON.stringify(value.candidate.metadata))C.fail('broker_response_invalid');}
    else if(value.status==='active'||value.effectiveCredential.epoch!==Number(row.expected_epoch)||effective.versionId!==row.expected_version_id||effective.digest!==row.expected_candidate_digest)C.fail('meta_business_version_changed',409);
    return structuredClone(value);
  }
  async function call(row,enrollment,source,name){
    const requestId=name==='status'?randomUUID():row.rotate_request_id,payload=name==='status'?{maintenanceId:row.maintenance_id}:{maintenanceId:row.maintenance_id,enrollmentId:row.enrollment_id,expectedEpoch:Number(row.expected_epoch),expectedVersionId:row.expected_version_id,expectedCandidateDigest:row.expected_candidate_digest};
    const response=await client.execute({requestId,operation:M.OPERATIONS[name],tenantRef:'clinic:'+C.clinics(enrollment.clinic_ids)[0],connectionRef:enrollment.connection_ref,assetRef:'meta-enroll:'+enrollment.scope_key,payload},{timeoutMs:name==='rotate'?30000:10000});
    if(!C.exact(response,'requestId,data,replayed')||response.requestId!==requestId||typeof response.replayed!=='boolean'||name==='status'&&response.replayed)C.fail('broker_response_invalid');return receipt(response.data,row,enrollment,source);
  }
  async function apply(id,remote){return requestTx(id,async({row,enrollment},transaction)=>{if(row.state==='succeeded')return row;
    if(enrollment.state!=='active')return update(row,{state:'failed',last_error:'meta_business_scope_changed',owner_receipt:JSON.stringify(remote),completed_at:now(),lease_token:null,lease_until:null},transaction);
    await bindings.committed(enrollment.enrollment_id,transaction,{allowExpiredCredential:true});const source=await context(enrollment,transaction);if(!source)C.fail('meta_business_scope_changed',409);
    receipt(remote,row,enrollment,source);if(!remote.activationApplied)C.fail('broker_response_invalid');
    if(source.value.epoch!==Number(row.expected_epoch)||source.value.versionId!==row.expected_version_id||source.value.digest!==row.expected_candidate_digest)C.fail('meta_business_version_changed',409);
    const candidate={versionId:remote.candidate.versionId,digest:remote.candidate.digest,...remote.candidate.metadata};if(C.F.expiry(candidate)<=+now())C.fail('meta_business_expired',409);
    const ownerReceipt=JSON.stringify(remote),pointer=plain(await P.findByPk(enrollment.enrollment_id,opts(transaction))),values={enrollment_id:enrollment.enrollment_id,renewal_id:row.maintenance_id,epoch:Number(row.expected_epoch)+1,version_id:row.maintenance_id,candidate_digest:candidate.digest,candidate_metadata:JSON.stringify(candidate),owner_receipt_digest:C.hash(ownerReceipt),activated_at:now(),last_healthy_at:now(),unknown_since:null,last_error:null,last_error_at:null};
    if(pointer){const [changed]=await P.update(values,{where:{enrollment_id:enrollment.enrollment_id,epoch:Number(row.expected_epoch),version_id:row.expected_version_id,candidate_digest:row.expected_candidate_digest},transaction,logging:false});if(changed!==1)C.fail('meta_business_version_changed',409);}else if(Number(row.expected_epoch)===0)await P.create(values,{transaction,logging:false});else C.fail('meta_business_version_changed',409);
    const next=await update(row,{state:'succeeded',candidate_metadata:JSON.stringify(candidate),owner_receipt:ownerReceipt,completed_at:now(),last_healthy_at:now(),unknown_since:null,last_error:null,lease_token:null,lease_until:null},transaction);
    await record(next,enrollment,'meta_maintenance_activated',transaction);await schedule(enrollment,{transaction});return next;
  });}
  async function reconcile(id){
    const captured=await requestTx(id,async({row,enrollment},transaction)=>{if(TERMINAL.includes(row.state))return null;
      if(enrollment.state!=='active'){await update(row,{state:'failed',last_error:'meta_business_scope_changed',completed_at:now(),lease_token:null,lease_until:null},transaction);return null;}
      const pending=models.MetaMarketingBusinessHandover?await models.MetaMarketingBusinessHandover.findOne({...opts(transaction),where:{old_enrollment_id:enrollment.enrollment_id,pending_scope_key:enrollment.scope_key}}):null;
      if(pending){await update(row,{next_attempt_at:new Date(+now()+300000),lease_token:null,lease_until:null},transaction);return null;}
      await bindings.committed(enrollment.enrollment_id,transaction,{allowExpiredCredential:true});const source=await context(enrollment,transaction);if(!source)C.fail();
      if(source.value.epoch!==Number(row.expected_epoch)||source.value.versionId!==row.expected_version_id||source.value.digest!==row.expected_candidate_digest){await update(row,{state:'failed',last_error:'meta_business_version_changed',completed_at:now(),lease_token:null,lease_until:null},transaction);return null;}
      if(!row.rotate_sent_at&&C.F.expiry(source.value.metadata)-START>+now()){await update(row,{next_attempt_at:new Date(C.F.expiry(source.value.metadata)-START),lease_token:null,lease_until:null},transaction);return null;}
      return {row,enrollment,source};});if(!captured)return;
    let {row,enrollment,source}=captured,remote=await call(row,enrollment,source,'status');if(remote.activationApplied)return apply(id,remote);
    if(['rejected','interrupted'].includes(remote.status))return requestTx(id,async(currentValue,transaction)=>{const next=await update(currentValue.row,{state:'human_required',owner_receipt:JSON.stringify(remote),last_error:'authorization_required',completed_at:now(),lease_token:null,lease_until:null},transaction);await record(next,currentValue.enrollment,'meta_maintenance_rejected',transaction);return next;});
    if(remote.status==='processing')return requestTx(id,async(value,transaction)=>{return update(value.row,{state:'running',owner_receipt:JSON.stringify(remote),next_attempt_at:new Date(+now()+30000),lease_token:null,lease_until:null},transaction);});
    if(!enabled())return;
    row=await requestTx(id,async(currentValue,transaction)=>{const fresh=currentValue.row;
      if(TERMINAL.includes(fresh.state))return null;const reset=+now()-+fresh.window_started_at>=DAY,attempts=reset?0:Number(fresh.attempts);
      if(attempts>=5){await update(fresh,{state:'retry_wait',next_attempt_at:new Date(Math.max(+fresh.next_attempt_at,+fresh.window_started_at+DAY)),lease_token:null,lease_until:null,last_error:'automatic_renewal_failed'},transaction);return null;}
      const next=await update(fresh,{state:'running',attempts:attempts+1,window_started_at:reset?now():fresh.window_started_at,last_attempt_at:now(),rotate_sent_at:fresh.rotate_sent_at||now()},transaction);
      if(!fresh.rotate_sent_at)await record(next,currentValue.enrollment,'meta_maintenance_requested',transaction);return next;});if(!row)return;
    remote=await call(row,enrollment,source,'rotate');if(remote.activationApplied)return apply(id,remote);
    return requestTx(id,async(value,transaction)=>{return update(value.row,{state:'retry_wait',owner_receipt:JSON.stringify(remote),next_attempt_at:new Date(+now()+30000),lease_token:null,lease_until:null,last_error:'outcome_unknown'},transaction);});
  }
  async function checkHealth(id){
    const captured=await requestTx(id,async(value,transaction)=>{if(value.enrollment.state!=='active'||TERMINAL.includes(value.row.state))return null;
      await bindings.committed(value.enrollment.enrollment_id,transaction,{allowExpiredCredential:true});const source=await context(value.enrollment,transaction);if(!source)return null;return {...value,source};});if(!captured)return false;
    const {row,enrollment,source}=captured,requestId=randomUUID(),payload={enrollmentId:enrollment.enrollment_id,expectedEpoch:source.value.epoch,expectedVersionId:source.value.versionId,expectedCandidateDigest:source.value.digest};
    try{
      const response=await client.execute({requestId,operation:M.OPERATIONS.health,tenantRef:'clinic:'+C.clinics(enrollment.clinic_ids)[0],connectionRef:enrollment.connection_ref,assetRef:'meta-enroll:'+enrollment.scope_key,payload},{timeoutMs:30000}),v=response?.data;
      if(!C.exact(response,'requestId,data,replayed')||response.requestId!==requestId||response.replayed!==false||!C.exact(v,'enrollmentId,epoch,versionId,digest,verifiedAt,expiresAt,dataAccessExpiresAt,healthy,reason')
        ||v.enrollmentId!==enrollment.enrollment_id||v.epoch!==source.value.epoch||v.versionId!==source.value.versionId||v.digest!==source.value.digest||!Number.isSafeInteger(v.verifiedAt)||Math.abs(v.verifiedAt-+now())>60000
        ||typeof v.healthy!=='boolean'||(v.healthy?v.reason!==null:!['credential_revoked','permissions_lost'].includes(v.reason))||![v.expiresAt,v.dataAccessExpiresAt].every(value=>value===null||Number.isSafeInteger(value)&&value>0))C.fail('broker_response_invalid');
      const pin={enrollmentId:enrollment.enrollment_id,epoch:v.epoch,versionId:v.versionId};
      if(v.healthy)await credentials.recordHealthy(pin,v);else await credentials.recordFailure(pin,{code:v.reason});
      await requestTx(id,async(value,transaction)=>{if(TERMINAL.includes(value.row.state)||value.enrollment.state!=='active')return;const fresh=await context(value.enrollment,transaction);
        if(fresh.value.epoch!==v.epoch||fresh.value.versionId!==v.versionId||fresh.value.digest!==v.digest)return;
        await update(value.row,{health_metadata:JSON.stringify(v),last_health_at:new Date(v.verifiedAt),last_healthy_at:v.healthy?new Date(v.verifiedAt):value.row.last_healthy_at,health_next_at:new Date(v.verifiedAt+HEALTH_INTERVAL),last_health_error:v.reason,unknown_since:null,
          ...(!v.healthy?{state:'human_required',last_error:'authorization_required',completed_at:now(),lease_token:null,lease_until:null}:{})},transaction);
      });return v.healthy;
    }catch(error){const retryAfter=Number.isSafeInteger(error.retryAfterMs)&&error.retryAfterMs>=0?Math.min(error.retryAfterMs,DAY):0;
      await requestTx(id,async(value,transaction)=>{if(!TERMINAL.includes(value.row.state))await update(value.row,{last_health_at:now(),last_health_error:C.safe(error),unknown_since:value.row.unknown_since||value.row.health_next_at||now(),health_next_at:new Date(+now()+Math.max(1800000,retryAfter)),lease_token:null,lease_until:null},transaction);});return false;}
  }
  let running=false;
  async function run(){if(!enabled()||!T||running)return {status:'completed',skipped:true};running=true;let processed=0,failed=0;
    try{
      const enrollments=await R.findAll({where:{state:'active'},attributes:['enrollment_id'],order:[['enrollment_id','ASC']],limit:100,raw:true,logging:false});
      for(const value of enrollments)await tx(async transaction=>{const enrollment=plain(await R.findByPk(value.enrollment_id,opts(transaction)));if(enrollment?.state==='active')await schedule(enrollment,{transaction});});
      const deadline=+now()+30000;
      // Discover IDs without locking T. Every mutation then acquires the
      // enrollment lock before its maintenance row, including lease claims.
      const due=await T.findAll({where:{state:{[Op.in]:['scheduled','running','retry_wait']},[Op.or]:[{next_attempt_at:{[Op.lte]:now()}},{health_next_at:{[Op.lte]:now()}}]},order:[['next_attempt_at','ASC']],limit:50,attributes:['maintenance_id'],raw:true,logging:false});
      for(const candidate of due){if(processed+failed>=10||+now()>=deadline)break;
        const row=await requestTx(candidate.maintenance_id,async(value,transaction)=>{if(TERMINAL.includes(value.row.state)||value.row.lease_until&&+value.row.lease_until>+now()||+value.row.next_attempt_at>+now()&&(!value.row.health_next_at||+value.row.health_next_at>+now()))return null;
          return update(value.row,{lease_token:randomUUID(),lease_until:new Date(+now()+120000)},transaction);});if(!row)continue;
        try{
          if(row.health_next_at&&+row.health_next_at<=+now()&&!await checkHealth(row.maintenance_id)){failed++;continue;}
          if(+row.next_attempt_at<=+now())await reconcile(row.maintenance_id);
          else await requestTx(row.maintenance_id,async(value,transaction)=>{if(!TERMINAL.includes(value.row.state))await update(value.row,{lease_token:null,lease_until:null},transaction);});
          processed++;
        }catch(error){failed++;await requestTx(row.maintenance_id,async(value,transaction)=>{if(TERMINAL.includes(value.row.state))return;
          const retryAfter=Number.isSafeInteger(error.retryAfterMs)&&error.retryAfterMs>=0?Math.min(error.retryAfterMs,DAY):0,delay=Math.max(BACKOFF[Math.min(Math.max(Number(value.row.attempts)-1,0),4)],retryAfter);
          await update(value.row,{state:'retry_wait',last_error:C.safe(error),next_attempt_at:new Date(+now()+delay),lease_token:null,lease_until:null},transaction);});}
      }return {status:failed?'failed':'completed',retryable:false,processed,failed};
    }finally{running=false;}
  }
  return {getMaintenanceStatus,schedule,reconcile,checkHealth,run};
}
let singleton;const instance=()=>singleton||=createMaintenance({models:require('../../models'),client:require('./metaMarketingOAuthClient.service').createClient()});
module.exports={createMaintenance,DAY,START,SAFETY,BACKOFF,getMaintenanceStatus:(...args)=>instance().getMaintenanceStatus(...args),run:()=>process.env.RUNTIME_ROLE==='gateway'?Promise.resolve({status:'completed',skipped:true}):instance().run()};
