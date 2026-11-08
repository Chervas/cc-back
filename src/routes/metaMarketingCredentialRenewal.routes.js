'use strict';
const C=require('../services/metaMarketingCredentialRenewal.contract');
function createRouter({service=require('../services/metaMarketingCredentialRenewal.service'),sessions=require('../services/accessSession.service')}={}){
  const router=require('express').Router({strict:true});
  const handler=name=>async(req,res)=>{
    res.set('Cache-Control','private, no-store');res.set('Referrer-Policy','no-referrer');res.set('X-Content-Type-Options','nosniff');
    try{
      const claims=await sessions.verify(require('../services/accessSession.service').bearer(req.headers.authorization));
      if(claims.sessionVersion!==1||!C.UUID.test(claims.jti)||!C.positive(claims.userId))C.fail('meta_renewal_session_required',401);
      if(Object.keys(req.query).some(key=>!['clinic_id','group_id','assignment_scope'].includes(key)))C.fail('meta_renewal_invalid',400);
      const type=req.query.assignment_scope||(!req.query.clinic_id&&req.query.group_id?'group':'clinic'),id=type==='group'?req.query.group_id:req.query.clinic_id;
      if(!['clinic','group'].includes(type)||typeof id!=='string'||!/^[1-9][0-9]{0,9}$/.test(id)||!C.positive(Number(id))
        ||type==='clinic'&&req.query.group_id!==undefined||type==='group'&&req.query.clinic_id!==undefined)C.fail('meta_renewal_invalid',400);
      const body=req.body===undefined?{}:req.body,keys=name==='confirm'?'candidateDigest':'';
      if(!body||Object.getPrototypeOf(body)!==Object.prototype||Object.keys(body).sort().join(',')!==keys)C.fail('meta_renewal_invalid',400);
      if(['confirm','reconcile','cancel'].includes(name)&&!C.UUID.test(req.params.id))C.fail('meta_renewal_invalid',400);
      if(name==='confirm'&&(typeof body.candidateDigest!=='string'||!C.HASH.test(body.candidateDigest)))C.fail('meta_renewal_invalid',400);
      const input={scopeKey:type+':'+id,actorId:claims.userId,sessionRef:claims.jti,sessionExpiresAt:new Date(claims.exp*1000)};
      return res.json(await service[name](input,req.params.id,body.candidateDigest));
    }catch(error){
      const status=['JsonWebTokenError','TokenExpiredError'].includes(error?.name)?401:[400,401,403,409,429].includes(error?.httpStatus)?error.httpStatus:503;
      return res.status(status).json({success:false,error:C.safe(error)});
    }
  };
  router.get('/credential-renewal',handler('overview'));router.post('/credential-renewal',handler('begin'));
  router.post('/credential-renewal/:id/reconcile',handler('reconcile'));router.post('/credential-renewal/:id/confirmation',handler('confirm'));
  router.delete('/credential-renewal/:id',handler('cancel'));return router;
}
module.exports={createRouter};
