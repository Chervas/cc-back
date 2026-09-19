'use strict';
const C=require('../services/metaMarketingOAuth.contract'),{safe}=require('../services/metaMarketingOAuth.service');
function createRouter({service=require('../services/metaMarketingOAuth.service'),sessions=require('../services/accessSession.service'),returnOrigin=C.frontendOrigin()}={}){
  const router=require('express').Router({strict:true});
  const headers=res=>{res.set('Cache-Control','private, no-store');res.set('Referrer-Policy','no-referrer');res.set('X-Content-Type-Options','nosniff');};
  const redirect=(res,origin,id=null,error=false)=>{
    const url=new URL('/pages/settings',origin);if(id)url.searchParams.set('meta_authorization',id);if(error)url.searchParams.set('meta_authorization_error','1');return res.redirect(303,url.toString());
  };
  router.get('/callback',async(req,res)=>{
    headers(res);
    try{
      if(Object.keys(req.query).some(k=>!['state','code','error','error_reason','error_description'].includes(k))||typeof req.query.state!=='string'
        ||req.query.code!==undefined&&typeof req.query.code!=='string'||req.query.error!==undefined&&typeof req.query.error!=='string')C.fail('meta_oauth_state_invalid',400);
      const result=await service.callback({state:req.query.state,code:req.query.code,denied:!!req.query.error});
      return redirect(res,result.returnOrigin,result.requestId);
    }catch{return redirect(res,returnOrigin,null,true);}
  });
  const handler=name=>async(req,res)=>{
    headers(res);
    try{
      const claims=await sessions.verify(require('../services/accessSession.service').bearer(req.headers.authorization));
      if(claims.sessionVersion!==1||!C.UUID.test(claims.jti)||!C.positive(claims.userId))C.fail('meta_oauth_session_required',401);
      if(req.body!==undefined&&(req.body===null||Object.getPrototypeOf(req.body)!==Object.prototype||Object.keys(req.body).length))C.fail('meta_oauth_scope_invalid',400);
      if(Object.keys(req.query).some(k=>!['clinic_id','group_id','assignment_scope'].includes(k)))C.fail('meta_oauth_scope_invalid',400);
      const type=req.query.assignment_scope||(!req.query.clinic_id&&req.query.group_id?'group':'clinic'),id=type==='group'?req.query.group_id:req.query.clinic_id;
      if(!['clinic','group'].includes(type)||typeof id!=='string'||!/^[1-9][0-9]{0,9}$/.test(id)||!C.positive(Number(id)))C.fail('meta_oauth_scope_invalid',400);
      for(const value of [req.query.clinic_id,req.query.group_id])if(value!==undefined&&(typeof value!=='string'||!/^[1-9][0-9]{0,9}$/.test(value)||!C.positive(Number(value))))C.fail('meta_oauth_scope_invalid',400);
      // Reject an ambiguous extra pivot instead of silently authorizing one scope over another.
      if(type==='clinic'&&req.query.group_id||type==='group'&&req.query.clinic_id)C.fail('meta_oauth_scope_invalid',400);
      const input={scopeKey:type+':'+id,actorId:claims.userId,sessionRef:claims.jti,sessionExpiresAt:new Date(claims.exp*1000)};
      if(['cancel','reconcile'].includes(name)&&!C.UUID.test(req.params.id))C.fail('meta_oauth_state_invalid',400);
      return res.json(await service[name](input,req.params.id));
    }catch(e){
      const code=safe(e),status=e?.name==='JsonWebTokenError'?401:[400,401,403,409,429].includes(e.httpStatus)?e.httpStatus:503;
      return res.status(status).json({success:false,error:code});
    }
  };
  router.get('/authorization',handler('status'));router.post('/authorization',handler('begin'));
  router.delete('/authorization/:id',handler('cancel'));router.post('/authorization/:id/reconcile',handler('reconcile'));
  return router;
}
module.exports={createRouter};
