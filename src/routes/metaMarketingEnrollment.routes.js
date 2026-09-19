'use strict';
const C=require('../services/metaMarketingEnrollment.contract'),{safe}=require('../services/metaMarketingEnrollment.service');
function createRouter({service=require('../services/metaMarketingEnrollment.service'),sessions=require('../services/accessSession.service')}={}){
  const router=require('express').Router({strict:true});
  const handler=name=>async(req,res)=>{
    res.set('Cache-Control','private, no-store');res.set('Referrer-Policy','no-referrer');res.set('X-Content-Type-Options','nosniff');
    try{
      const claims=await sessions.verify(require('../services/accessSession.service').bearer(req.headers.authorization));
      if(claims.sessionVersion!==1||!C.UUID.test(claims.jti)||!C.positive(claims.userId))C.fail('meta_oauth_session_required',401);
      if(Object.keys(req.query).some(k=>!['clinic_id','group_id','assignment_scope'].includes(k)))C.fail('meta_enrollment_invalid',400);
      const type=req.query.assignment_scope||(!req.query.clinic_id&&req.query.group_id?'group':'clinic'),id=type==='group'?req.query.group_id:req.query.clinic_id;
      if(!['clinic','group'].includes(type)||typeof id!=='string'||!/^[1-9][0-9]{0,9}$/.test(id)||!C.positive(Number(id))
        ||type==='clinic'&&req.query.group_id!==undefined||type==='group'&&req.query.clinic_id!==undefined)C.fail('meta_enrollment_invalid',400);
      const body=req.body===undefined?{}:req.body,keys=name==='reserve'?'flowId,assetRefs':name==='confirm'?'selectionDigest':'';
      if(!body||Object.getPrototypeOf(body)!==Object.prototype||Object.keys(body).sort().join(',')!==keys.split(',').filter(Boolean).sort().join(','))C.fail('meta_enrollment_invalid',400);
      if(['confirm','cancel'].includes(name)&&!C.UUID.test(req.params.id))C.fail('meta_enrollment_invalid',400);
      if(name==='reserve'&&(typeof body.flowId!=='string'||!C.UUID.test(body.flowId)||!Array.isArray(body.assetRefs)||!body.assetRefs.length||body.assetRefs.length>100
        ||new Set(body.assetRefs).size!==body.assetRefs.length||body.assetRefs.some(v=>typeof v!=='string'||!/^meta-(ad_account|facebook_page|instagram_business):[1-9][0-9]{0,29}$/.test(v))))C.fail('meta_enrollment_invalid',400);
      if(name==='confirm'&&(typeof body.selectionDigest!=='string'||!C.HASH.test(body.selectionDigest)))C.fail('meta_enrollment_invalid',400);
      const input={scopeKey:type+':'+id,actorId:claims.userId,sessionRef:claims.jti,sessionExpiresAt:new Date(claims.exp*1000)};
      const result=name==='reserve'?await service.reserve(input,body.flowId,body.assetRefs):name==='confirm'?await service.confirm(input,req.params.id,body.selectionDigest):
        name==='cancel'?await service.cancel(input,req.params.id):await service.overview(input);
      return res.json(result);
    }catch(error){
      const status=['JsonWebTokenError','TokenExpiredError'].includes(error?.name)?401:[400,401,403,409,429].includes(error?.httpStatus)?error.httpStatus:503;
      return res.status(status).json({success:false,error:safe(error)});
    }
  };
  router.get('/enrollment',handler('overview'));router.post('/enrollment',handler('reserve'));
  router.post('/enrollment/:id/confirmation',handler('confirm'));router.delete('/enrollment/:id',handler('cancel'));return router;
}
module.exports={createRouter};
