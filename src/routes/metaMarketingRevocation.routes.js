'use strict';
const {Op}=require('sequelize'),R=require('../services/metaMarketingRevocation.contract');
const S=require('../services/metaMarketingBrokerScope.service'),revocations=require('../services/metaMarketingRevocation.service');
const scopeAccess=require('../lib/oauthMarketingScopeAccess'),{hasMarketingClinicScopeAccess}=require('../lib/marketingScopeAccess');
const fail=(code,status)=>{throw Object.assign(Error(code),{code,httpStatus:status});};
const bounded=rows=>{if(!Array.isArray(rows)||rows.length>1000)R.fail();return rows;};
function createService({models,sessions,enabled=()=>process.env.META_MARKETING_REVOCATION_ENABLED==='true',now=()=>new Date()}){
  async function authorize(req,transaction){
    const options={raw:true,logging:false,...(transaction?{transaction,lock:transaction.LOCK.UPDATE}:{})};
    const result=await scopeAccess.authorizeRequestedMarketingConnectionScope({userId:req.userData.userId,...scopeAccess.marketingScopeInputFromRequest(req),access:'write',
      findClinicGroupId:async id=>(await models.Clinica.findByPk(id,{...options,attributes:['grupoClinicaId']}))?.grupoClinicaId,
      findGroupClinicIds:async id=>bounded(await models.Clinica.findAll({...options,attributes:['id_clinica'],where:{grupoClinicaId:id},order:[['id_clinica','ASC']],limit:1001})).map(r=>r.id_clinica),
      authorizeClinicIds:args=>hasMarketingClinicScopeAccess({...args,membershipModel:{findAll:opts=>models.UsuarioClinica.findAll({...opts,...options})}})});
    if(!result?.requested)fail('meta_revocation_scope_required',400);
    return {scopeKey:R.scopeKey(`${result.assignmentScope}:${result.assignmentScope==='group'?result.groupId:result.clinicId}`),clinicIds:R.ids(result.clinicIds)};
  }
  async function authenticate(req){
    let claims;try{claims=await sessions.verify(require('../services/accessSession.service').bearer(req.headers.authorization));}catch{fail('meta_revocation_session_required',401);}
    if(claims?.sessionVersion!==1||!R.UUID.test(claims.jti)||!S.positive(claims.userId)||!Number.isSafeInteger(claims.exp)
      ||req.userData&&Number(req.userData.userId)!==Number(claims.userId))fail('meta_revocation_session_required',401);
    req.userData={...req.userData,userId:claims.userId};return claims;
  }
  async function status(req){
    await authenticate(req);const before=await authorize(req);
    if(!enabled())return {enabled:false,available:false,status:'none',pending_assets:0,confirmed_assets:0};
    const rows=bounded(await models.MetaMarketingBrokerRevocation.findAll({attributes:['state','clinic_ids'],where:{scope_key:before.scopeKey},raw:true,logging:false,limit:1001}));
    if(rows.some(r=>!['pending','confirmed'].includes(r.state)||R.storedIds(r.clinic_ids).some(id=>!before.clinicIds.includes(id))))R.fail();
    const bindings=bounded(await models.MetaMarketingBrokerBinding.findAll({attributes:['mapping_id','state'],where:{scope_key:before.scopeKey},raw:true,logging:false,limit:1001}));
    if(bindings.some(r=>!['staged','active','blocked'].includes(r.state)))R.fail();
    await authenticate(req);if(JSON.stringify(await authorize(req))!==JSON.stringify(before))fail('meta_revocation_scope_changed',409);
    const pending=rows.filter(r=>r.state==='pending').length,confirmed=rows.filter(r=>r.state==='confirmed').length;
    return {enabled:true,available:bindings.some(r=>r.state!=='blocked'),status:pending?'pending':confirmed?'confirmed':'none',pending_assets:pending,confirmed_assets:confirmed};
  }
  async function disconnect(req){
    const claims=await authenticate(req),before=await authorize(req);
    if(!enabled())fail('meta_revocation_disabled',503);
    if(req.body&&Object.keys(req.body).length)fail('meta_revocation_invalid_request',400);
    const result=await models.sequelize.transaction(async transaction=>{
      try{await sessions.verifyReference({userId:claims.userId,sessionRef:claims.jti,expiresAt:new Date(claims.exp*1000)},{transaction});}
      catch(error){fail('meta_revocation_session_required',error?.httpStatus===403?403:401);}
      const current=await authorize(req,transaction);
      if(JSON.stringify(current)!==JSON.stringify(before))fail('meta_revocation_scope_changed',409);
      if(!enabled())fail('meta_revocation_disabled',503);
      return revocations.enqueue({models,transaction,...current,actorId:claims.userId,sessionRef:claims.jti,now:now(),enabled:'true'});
    });
    return {success:true,available:false,status:result.pending?'pending':result.confirmed?'confirmed':'none',pending_assets:result.pending,confirmed_assets:result.confirmed};
  }
  return {status,disconnect};
}
function createRouter(options){
  const router=require('express').Router(),service=createService(options);
  const handler=method=>async(req,res)=>{
    res.set('Cache-Control','private, no-store');
    try{const result=await service[method](req);return res.status(method==='disconnect'&&result.status==='pending'?202:200).json(result);}
    catch(error){const status=[400,401,403,409].includes(error?.httpStatus)?error.httpStatus:503;
      const safe=['meta_revocation_scope_required','meta_revocation_scope_changed','meta_revocation_session_required','meta_revocation_disabled','meta_revocation_invalid_request','meta_revocation_shared_scope'];
      return res.status(status).json({success:false,error:safe.includes(error?.code)?error.code:status===403?'meta_revocation_scope_forbidden':status===400?'meta_revocation_invalid_request':'meta_revocation_unavailable'});}
  };
  router.get('/',handler('status'));router.delete('/',handler('disconnect'));return router;
}
module.exports={createService,createRouter};
