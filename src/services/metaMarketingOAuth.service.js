'use strict';
const {randomUUID,randomBytes}=require('node:crypto'),{Op}=require('sequelize');
const C=require('./metaMarketingOAuth.contract'),B=require('../../services/integrations-broker/src/meta-marketing-oauth-contract');
const {fromFlow}=require('../../services/platform-audit/src/meta-oauth-event');
const D=require('../../services/integrations-broker/src/meta-marketing-discovery-contract'),{fromDiscovery}=require('../../services/platform-audit/src/meta-discovery-event');
const SAFE=new Set(['meta_oauth_unavailable','meta_oauth_disabled','meta_oauth_scope_invalid','meta_oauth_scope_changed','meta_oauth_scope_forbidden','meta_oauth_scope_blocked',
  'meta_oauth_session_required','auth_email_verification_required','meta_oauth_busy','meta_oauth_state_invalid','meta_oauth_outcome_unknown','meta_oauth_unconfigured',
  'broker_response_invalid','broker_configuration_invalid','broker_timeout','broker_unavailable','audit_unavailable']);
const safe=e=>SAFE.has(e?.code)?e.code:'meta_oauth_unavailable';
function createService({models,sessions,client,now=()=>new Date(),enabled=()=>process.env.META_MARKETING_OAUTH_ENABLED==='true',
  workerEnabled=()=>process.env.META_MARKETING_OAUTH_WORKER_ENABLED==='true',discoveryEnabled=()=>process.env.META_MARKETING_OAUTH_DISCOVERY_ENABLED==='true',returnOrigin='https://crm.clinicaclick.com'}){
  const origin=new URL(returnOrigin);if(origin.origin!==returnOrigin||!['http:','https:'].includes(origin.protocol))C.fail();
  const R=models.MetaMarketingOAuthRequest,S=models.MetaMarketingOAuthSlot,scope=require('./metaMarketingOAuthScope.service').createScope({models,sessions,now});
  const audit=require('./platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const reviewAssignment=require('./metaMarketingEnrollmentReview.service').createReview({models,now});
  const tx=fn=>models.sequelize.transaction({isolationLevel:'REPEATABLE READ'},fn),locked=transaction=>({transaction,lock:transaction.LOCK.UPDATE,logging:false});
  const plain=r=>r?.get?r.get({plain:true}):r;
  const gate=()=>{if(!enabled())C.fail('meta_oauth_disabled');};
  const actor=row=>({scopeKey:row.scope_key,actorId:Number(row.actor_user_id),sessionRef:row.session_ref,sessionExpiresAt:row.session_expires_at});
  const projection=row=>({requestId:row.flow_id,status:row.state,connected:false,expiresAt:row.expires_at.toISOString(),
    pending:!['staged','cancelled','interrupted'].includes(row.state),clinicCount:JSON.parse(row.clinic_ids).length,cancellationConfirmed:row.state==='cancelled',
    candidateReady:row.state==='staged',canListAssets:discoveryEnabled()&&row.state==='staged'});
  async function recordEvent(value,transaction){
    const health=await audit.health(now(),{includeUnresolved:false,transaction});
    if(!Number.isSafeInteger(health.pending)||health.pending>=9999||health.oldestAgeSeconds>=3600)C.fail('audit_unavailable');
    await audit.append(value,{transaction});
  }
  const record=(row,reason,transaction,worker=false)=>recordEvent(fromFlow(row,reason,now(),worker),transaction);
  async function authorizedRow(row,transaction){
    gate();await scope.revalidate(row,transaction);const fresh=await R.findByPk(row.flow_id,locked(transaction));
    if(!fresh||['slot_digest','scope_digest','session_ref','actor_user_id','state_hash','connection_ref','asset_ref','clinic_ids','scopes','app_id'].some(k=>fresh[k]!==row[k]))C.fail('meta_oauth_scope_changed',409);
    return fresh;
  }
  async function cancelInTransaction(row,transaction,worker=false,sessionRef=row.session_ref){
      const current=await R.findByPk(row.flow_id,locked(transaction));if(!current)C.fail('meta_oauth_state_invalid',400);
      if(!['cancel_pending','cancelled'].includes(current.state)){
        await record({...plain(current),session_ref:sessionRef},'authorization_cancel_requested',transaction,worker);
        await current.update({state:'cancel_pending',next_attempt_at:now(),last_error:null},{transaction});
      }
      if(models.MetaMarketingEnrollmentRequest)await require('./metaMarketingEnrollment.service').createService({models,sessions,now})
        .cancelFromOAuth(current.flow_id,transaction,worker?undefined:{actorId:Number(current.actor_user_id),sessionRef});
      return plain(current);
  }
  const cancelPending=(row,worker=false,sessionRef=row.session_ref)=>tx(t=>cancelInTransaction(row,t,worker,sessionRef));
  async function call(row,name,payload={}){
    const requestId=name==='begin'?row.flow_id:randomUUID();
    const value=await client.execute({requestId,operation:B.OPERATIONS[name],tenantRef:'clinic:'+JSON.parse(row.clinic_ids)[0],connectionRef:row.connection_ref,assetRef:row.asset_ref,
      payload:name==='begin'?payload:{flowId:row.flow_id,...payload}},{timeoutMs:name==='finish'?30000:10000});
    if(!value||value.requestId!==requestId||typeof value.replayed!=='boolean'||!value.data)C.fail('broker_response_invalid');
    const v=value.data;
    if(name==='begin'){
      if(!C.exact(v,'flowId,authUrl,expiresAt')||v.flowId!==row.flow_id||v.expiresAt!==+row.expires_at||typeof v.authUrl!=='string'||v.authUrl.length>8192)C.fail('broker_response_invalid');
      let url;try{url=new URL(v.authUrl);}catch{C.fail('broker_response_invalid');}
      const expected={client_id:row.app_id,redirect_uri:row.redirect_uri,response_type:'code',scope:JSON.parse(row.scopes).join(','),state:payload.state};
      if(url.origin!=='https://www.facebook.com'||url.pathname!=='/v24.0/dialog/oauth'||url.username||url.password||url.hash
        ||[...url.searchParams.keys()].sort().join(',')!==Object.keys(expected).sort().join(',')||Object.entries(expected).some(([k,x])=>url.searchParams.get(k)!==x))C.fail('broker_response_invalid');
    }else{
      if(!C.exact(v,'flowId,status,connectionRef,scopeKey,expiresAt,accessBlocked,candidate')||v.flowId!==row.flow_id||v.connectionRef!==row.connection_ref||v.scopeKey!==row.scope_key
        ||!['awaiting','exchanging','staging','staged','interrupted','aborted'].includes(v.status)||v.accessBlocked!==true||!Number.isSafeInteger(v.expiresAt)
        ||v.status!=='aborted'&&v.expiresAt!==+row.expires_at||(v.status==='staged'?!v.candidate:v.candidate!==null)) {
        C.fail('broker_response_invalid');
      }
      if(v.candidate)C.candidate(v.candidate,row);
    }
    return v;
  }
  async function reconcileRow(row,{worker=false,ownedLease=null}={}){
    if(row.state==='cancelled')return row;
    if(row.state!=='cancel_pending'){
      try{await tx(t=>authorizedRow(row,t));}
      catch(e){if([401,403,409].includes(e.httpStatus)||e.code==='meta_oauth_disabled')row=await cancelPending(row,true);else throw e;}
    }
    const remote=await call(row,row.state==='cancel_pending'?'abort':'status');
    if(row.state==='cancel_pending'){
      if(remote.status!=='aborted')C.fail('broker_response_invalid');
      return tx(async transaction=>{
        const current=await R.findByPk(row.flow_id,locked(transaction));
        if(!current||!['cancel_pending','cancelled'].includes(current.state)||ownedLease&&(current.lease_token!==ownedLease||+current.lease_until<=+now()))C.fail();
        if(current.state!=='cancelled'){
          await record(plain(current),'authorization_cancelled',transaction,true);
          await current.update({state:'cancelled',completed_at:now(),lease_token:null,lease_until:null,last_error:null},{transaction});
        }
        return plain(current);
      });
    }
    if(remote.status==='aborted'||remote.status==='interrupted'||row.expires_at<=now()&&remote.status!=='staged'){
      row=await cancelPending(row,true);return reconcileRow(row,{worker:true,ownedLease});
    }
    try{
      return await tx(async transaction=>{
        const current=await authorizedRow(row,transaction);
        if(ownedLease&&(current.lease_token!==ownedLease||+current.lease_until<=+now()))C.fail();
        if(['cancel_pending','cancelled'].includes(current.state))C.fail('meta_oauth_scope_changed',409);
        if(remote.status==='staged'){
          const candidate=C.candidate(remote.candidate,row);
          if([candidate.expiresAt,candidate.dataAccessExpiresAt].some(v=>v!==null&&v<=+now()))C.fail('meta_oauth_scope_changed',409);
          if(current.state!=='staged')await record(plain(current),'credentials_staged',transaction,worker);
          else if(current.candidate_metadata!==JSON.stringify(candidate))C.fail('broker_response_invalid');
          await current.update({state:'staged',candidate_metadata:JSON.stringify(candidate),completed_at:now(),lease_token:null,lease_until:null,last_error:null},{transaction});
        }else await current.update({next_attempt_at:new Date(+now()+30000),lease_token:null,lease_until:null},{transaction});
        return plain(current);
      });
    }catch(e){if([401,403,409].includes(e.httpStatus))await cancelPending(row,true);throw e;}
  }
  const service={
    async cancelAfterEnrollment(enrollment,transaction){
      // Internal hook: only a locally committed withdrawal of this exact
      // selection can queue retirement of its OAuth candidate. No user session
      // is required to finish an already authorized withdrawal.
      if(!transaction||!models.MetaMarketingEnrollmentRequest||!C.UUID.test(enrollment.enrollment_id))C.fail();
      const saved=await models.MetaMarketingEnrollmentRequest.findByPk(enrollment.enrollment_id,locked(transaction));
      if(!saved||saved.state!=='revoked'||saved.flow_id!==enrollment.flow_id||saved.scope_key!==enrollment.scope_key)C.fail();
      return cancelInTransaction({flow_id:saved.flow_id},transaction,true);
    },
    async assets(input,id){
      gate();if(!discoveryEnabled())C.fail('meta_oauth_disabled');if(!C.UUID.test(id))C.fail('meta_oauth_state_invalid',400);
      const requestId=randomUUID(),startedAt=+now();let captured;
      const authorize=async transaction=>{
        gate();if(!discoveryEnabled())C.fail('meta_oauth_disabled');
        await scope.authorize(input,transaction);const row=await R.findByPk(id,locked(transaction));
        if(!row||row.scope_key!==input.scopeKey||Number(row.actor_user_id)!==input.actorId)C.fail('meta_oauth_scope_forbidden',403);
        await authorizedRow(plain(row),transaction);
        if(row.state!=='staged'||!row.candidate_metadata||captured&&captured.candidate_metadata!==row.candidate_metadata)C.fail('meta_oauth_scope_changed',409);
        const candidate=C.candidate(JSON.parse(row.candidate_metadata),plain(row));
        if([candidate.expiresAt,candidate.dataAccessExpiresAt].some(v=>v!==null&&v<=+now()))C.fail('meta_oauth_scope_changed',409);
        return plain(row);
      };
      try{
        captured=await tx(async transaction=>{const row=await authorize(transaction);await recordEvent(fromDiscovery(row,input,requestId,'inventory_requested',now()),transaction);return row;});
        await tx(authorize);
        const response=await client.execute({requestId,operation:D.OPERATION,tenantRef:'clinic:'+JSON.parse(captured.clinic_ids)[0],connectionRef:captured.connection_ref,assetRef:captured.asset_ref,
          payload:{flowId:id,scopeDigest:captured.scope_digest}},{timeoutMs:30000});
        if(!C.exact(response,'requestId,data,replayed')||response.requestId!==requestId||response.replayed!==false)C.fail('broker_response_invalid');
        const inventory=D.validateResult(response.data,{flowId:id,candidateDigest:JSON.parse(captured.candidate_metadata).digest,scopeDigest:captured.scope_digest,scopeKey:captured.scope_key,
          clinicSetDigest:C.hash(captured.clinic_ids),metadata:JSON.parse(captured.candidate_metadata),startedAt,now:+now()});
        return await tx(async transaction=>{const row=await authorize(transaction);if(inventory.expiresAt<=+now())C.fail('broker_response_invalid');
          const assignmentReview=await reviewAssignment({row,inventory},transaction);
          await recordEvent(fromDiscovery(row,input,requestId,'inventory_verified',now(),inventory),transaction);return {...projection(row),inventory,assignmentReview};});
      }catch(e){
        if(captured)try{await tx(t=>recordEvent(fromDiscovery(captured,input,requestId,[401,403,409].includes(e.httpStatus)?'access_changed':'inventory_unavailable',now()),t));}catch{}
        throw e;
      }
    },
    async status(input){
      if(!enabled())return {enabled:false};
      return tx(async transaction=>{
        gate();
        const captured=await scope.capture(input,transaction),latest=await R.findOne({...locked(transaction),where:{scope_key:input.scopeKey},order:[['requested_at','DESC'],['flow_id','DESC']]});
        if(latest&&Number(latest.actor_user_id)!==input.actorId&&latest.state!=='cancelled')return {enabled:true,available:false,status:'busy'};
        return {enabled:true,available:!!captured.slot&&(!latest||latest.state==='cancelled'),...(latest?projection(plain(latest)):{status:'none'})};
      });
    },
    async begin(input){
      gate();const state=randomBytes(32).toString('base64url');
      const row=await tx(async transaction=>{
        const captured=await scope.capture(input,transaction);if(!captured.slot)C.fail('meta_oauth_unconfigured');
        if(await R.findOne({attributes:['flow_id'],where:{scope_key:input.scopeKey,state:{[Op.ne]:'cancelled'}},transaction}))C.fail('meta_oauth_busy',409);
        const {slot}=captured,expires=new Date(Math.min(+now()+600000,+input.sessionExpiresAt,+slot.expires_at));if(+expires<=+now())C.fail('meta_oauth_session_required',401);
        const fresh={flow_id:randomUUID(),state_hash:C.hash(state),scope_key:slot.scope_key,connection_ref:slot.connection_ref,asset_ref:slot.asset_ref,app_id:slot.app_id,
          clinic_ids:slot.clinic_ids,scopes:slot.scopes,redirect_uri:slot.redirect_uri,slot_digest:captured.slotDigest,scope_digest:captured.scopeDigest,actor_user_id:input.actorId,
          session_ref:input.sessionRef,session_expires_at:input.sessionExpiresAt,return_origin:returnOrigin,requested_at:now(),expires_at:expires,state:'begin_pending',next_attempt_at:expires};
        await record(fresh,'authorization_requested',transaction);return plain(await R.create(fresh,{transaction}));
      });
      try{
        const remote=await call(row,'begin',{state,scopeDigest:row.scope_digest,clinicSetDigest:C.hash(row.clinic_ids),expiresAt:+row.expires_at});
        await tx(async transaction=>{const current=await authorizedRow(row,transaction);if(current.state!=='begin_pending')C.fail('meta_oauth_scope_changed',409);await current.update({state:'awaiting'},{transaction});});
        return {enabled:true,...projection({...row,state:'awaiting'}),authUrl:remote.authUrl};
      }catch(e){await cancelPending(row,true);try{await reconcileRow({...row,state:'cancel_pending'},{worker:true});}catch{}throw e;}
    },
    async callback({state,code,denied=false}){
      if(!C.STATE.test(state)||!denied&&(typeof code!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(code)))C.fail('meta_oauth_state_invalid',400);
      let row=await R.findOne({where:{state_hash:C.hash(state)},raw:true,logging:false});if(!row)C.fail('meta_oauth_state_invalid',400);
      const result=()=>({returnOrigin:row.return_origin,requestId:row.flow_id});
      if(denied){await cancelPending(row,true);try{await reconcileRow({...row,state:'cancel_pending'},{worker:true});}catch{}return result();}
      let mayExchange=false;
      try{
        row=await tx(async transaction=>{
          const current=await authorizedRow(row,transaction);const digest=C.hash(code);
          if(current.code_digest&&current.code_digest!==digest)C.fail('meta_oauth_state_invalid',400);
          if(current.state!=='awaiting')return plain(current);
          if(current.expires_at<=now())C.fail('meta_oauth_scope_changed',409);
          if(await R.findOne({where:{code_digest:digest},attributes:['flow_id'],transaction}))C.fail('meta_oauth_state_invalid',400);
          await current.update({state:'processing',code_digest:digest,next_attempt_at:new Date(+now()+60000),lease_token:randomUUID(),lease_until:new Date(+now()+60000)},{transaction});
          mayExchange=true;return plain(current);
        });
        if(mayExchange){
          await tx(t=>authorizedRow(row,t));await call(row,'finish',{state,code});
          await reconcileRow(row,{ownedLease:row.lease_token});
        }
      }catch(e){
        if([401,403,409].includes(e.httpStatus)||e.code==='meta_oauth_disabled')await cancelPending(row,true);
        else if(mayExchange)await R.update({last_error:safe(e)},{where:{flow_id:row.flow_id,lease_token:row.lease_token}});
      }
      return result();
    },
    async cancel(input,id){
      if(!C.UUID.test(id))C.fail('meta_oauth_state_invalid',400);
      const row=await tx(async transaction=>{
        await scope.authorize(input,transaction);const current=await R.findByPk(id,locked(transaction));
        if(!current||current.scope_key!==input.scopeKey||Number(current.actor_user_id)!==input.actorId)C.fail('meta_oauth_scope_forbidden',403);
        return plain(current);
      });
      const pending=await cancelPending(row,false,input.sessionRef);try{return projection(await reconcileRow(pending));}catch{return projection(pending);}
    },
    async reconcile(input,id){
      const row=await tx(async transaction=>{await scope.authorize(input,transaction);const current=await R.findByPk(id,locked(transaction));
        if(!current||current.scope_key!==input.scopeKey||Number(current.actor_user_id)!==input.actorId)C.fail('meta_oauth_scope_forbidden',403);return plain(current);});
      if(row.lease_until&&row.lease_until>now())return projection(row);
      return projection(await reconcileRow(row));
    },
    async run({closing=()=>false}={}){
      if(!workerEnabled()||closing())return {status:'completed',skipped:true,reason:'meta_oauth_worker_disabled'};
      let processed=0,failed=0;const deadline=+now()+30000;
      for(let n=0;n<10&&+now()<deadline&&!closing();n++){
        const row=await tx(async transaction=>{
          const r=await R.findOne({...locked(transaction),skipLocked:true,where:{state:{[Op.in]:['begin_pending','awaiting','processing','cancel_pending','interrupted']},next_attempt_at:{[Op.lte]:now()},[Op.or]:[{lease_until:null},{lease_until:{[Op.lte]:now()}}]},order:[['requested_at','ASC'],['flow_id','ASC']]});
          if(!r)return null;await r.update({lease_token:randomUUID(),lease_until:new Date(+now()+120000),attempts:Math.min(Number(r.attempts)+1,1000000)},{transaction});return plain(r);
        });if(!row)break;
        try{
          let current=row;if(['begin_pending','awaiting','interrupted'].includes(row.state))current=await cancelPending(row,true);
          await reconcileRow(current,{worker:true,ownedLease:row.lease_token});processed++;
        }catch(e){failed++;await R.update({lease_token:null,lease_until:null,last_error:safe(e),next_attempt_at:new Date(+now()+Math.min(3600000,1000*2**Math.min(row.attempts,12)))},{where:{flow_id:row.flow_id,lease_token:row.lease_token}});}
      }
      return {status:failed?'failed':'completed',retryable:false,processed,failed};
    },
  };
  return service;
}
let singleton;const instance=()=>singleton||=createService({models:require('../../models'),sessions:require('./accessSession.service'),client:require('./metaMarketingOAuthClient.service').createClient(),returnOrigin:C.frontendOrigin()});
module.exports={createService,safe,...Object.fromEntries(['status','begin','callback','cancel','reconcile','assets','cancelAfterEnrollment'].map(k=>[k,(...args)=>instance()[k](...args)])),
  run:options=>process.env.RUNTIME_ROLE==='gateway'?Promise.resolve({status:'completed',skipped:true,reason:'gateway_runtime'}):process.env.META_MARKETING_OAUTH_WORKER_ENABLED==='true'?instance().run(options):Promise.resolve({status:'completed',skipped:true,reason:'meta_oauth_worker_disabled'})};
