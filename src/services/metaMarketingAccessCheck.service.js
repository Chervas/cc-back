'use strict';
const {randomUUID}=require('node:crypto');
const C=require('../../services/integrations-broker/src/meta-marketing-contract');
const {fromMetaAccessCheck}=require('../../services/platform-audit/src/meta-access-check-event');
const {createRepository}=require('./platformAudit.repository');
const fail=code=>{throw Object.assign(Error(code),{code});};
const denied=new Set(['meta_broker_scope_forbidden','meta_broker_session_required','scope_denied','asset_revoked','connection_blocked','meta_broker_scope_changed','meta_broker_binding_invalid']);
function createMetaMarketingAccessCheck({models,broker,sessions,authorizeScope,scopeInput,now=Date.now,
  enabled=()=>process.env.META_MARKETING_BROKER_ENABLED==='true'&&process.env.META_MARKETING_ACCESS_CHECK_ENABLED==='true'}){
  const m=()=>typeof models==='function'?models():models;
  async function execute(req,mappingId){
    if(!enabled())fail('broker_cohort_disabled');
    const initial=await sessions(req);
    if(initial?.sessionVersion!==1||!initial.jti||Number(initial.userId)!==Number(req.userData?.userId))fail('meta_broker_session_required');
    const actor={userId:initial.userId,sessionRef:initial.jti};
    const authorization=async()=>{
      try{return await authorizeScope(req);}catch(error){
        if(error?.httpStatus===403)fail('meta_broker_scope_forbidden');
        if(error?.httpStatus===400)fail('meta_broker_scope_invalid');
        fail('meta_broker_binding_invalid');
      }
    };
    const scoped=await authorization();
    if(!scoped?.requested)fail('meta_broker_scope_forbidden');
    const context=await broker.prepare(mappingId),captured=broker.describe(context);
    const requestedScope=scopeInput(req,scoped);
    // A group-owned credential must be explicitly checked in its full group scope.
    if(requestedScope!==captured.scopeKey)fail('meta_broker_scope_forbidden');
    const guard=async fresh=>{
      if(!enabled())fail('broker_cohort_disabled');
      const claims=await sessions(req);
      if(claims?.userId!==actor.userId||claims.jti!==actor.sessionRef||claims.sessionVersion!==1)fail('meta_broker_session_required');
      const latest=await authorization();
      if(!latest?.requested||scopeInput(req,latest)!==requestedScope
        ||JSON.stringify(latest.clinicIds.slice().sort((a,b)=>a-b))!==JSON.stringify(fresh.clinicIds))fail('meta_broker_scope_forbidden');
    };
    const requestId=randomUUID(),events=createRepository(m().PlatformAuditEvent);
    const record=async(reason,result=null)=>{
      const at=new Date(now());
      try{
        const health=await events.health(at,{includeUnresolved:false});
        if(!Number.isSafeInteger(health.pending)||health.pending>=10000||!Number.isFinite(health.oldestAgeSeconds)||health.oldestAgeSeconds>=3600)fail('audit_unavailable');
        await events.append(fromMetaAccessCheck({actor,captured,requestId,operation:C.ASSET,reason,result,now:at}));
      }catch{fail('audit_unavailable');}
    };
    await guard(captured);await record('check_requested');
    let data;
    try{data=await broker.read(context,C.ASSET,{authorize:guard,requestId});}
    catch(error){await record(denied.has(error?.code)?'access_changed':'read_unavailable');throw error;}
    // Evidence must be durable before a successful response leaves the API.
    await record('asset_verified',data);await guard(await broker.assertContext(context));
    return {requestId,verification:{status:'verified',verifiedAt:new Date(now()).toISOString(),asset:data},availability:{available:false,reason:'meta_security_quarantine'}};
  }
  return {execute,handler:()=>async(req,res)=>{
    res.set('Cache-Control','private, no-store');
    try{return res.json(await execute(req,req.params.mappingId));}
    catch(error){
      const code=error?.code;
      const status=code==='meta_broker_scope_invalid'?400:code==='meta_broker_session_required'?401:code==='meta_broker_scope_forbidden'||code==='scope_denied'?403:503;
      const safe=new Set(['broker_cohort_disabled','meta_broker_scope_invalid','meta_broker_session_required','meta_broker_scope_forbidden','meta_broker_binding_invalid','meta_broker_scope_changed','meta_broker_not_active','scope_denied','asset_revoked','connection_blocked','credential_revoked','audit_unavailable','rate_limited']);
      return res.status(status).json({success:false,error:safe.has(code)?code:'meta_broker_unavailable'});
    }
  }};
}
module.exports={createMetaMarketingAccessCheck};
