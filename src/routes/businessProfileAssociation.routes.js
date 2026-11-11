'use strict';
const express=require('express');const C=require('../services/businessProfileAssociation.contract');const defaults=require('../services/businessProfileAssociation.service');
function createRouter({service=defaults,sessions,authorizeScope,resolveConnection}){
 const router=express.Router();
 function requested(req,action){const post=req.method==='POST',v=post?req.body:req.query;if(!v||typeof v!=='object'||Array.isArray(v)||post&&Object.keys(req.query).length)C.fail();const allowed=['clinic_id','assignment_scope',...(action==='prepare'?['attemptId','sourceFingerprint','accountName','locationName','reviewDestinationChangeAccepted']:[])];if(v.reviewDestinationChangeAccepted!==undefined&&typeof v.reviewDestinationChangeAccepted!=='boolean')C.fail();if(!C.positive(v.clinic_id)||v.assignment_scope!==undefined&&v.assignment_scope!=='clinic'||Object.keys(v).some(k=>!allowed.includes(k)))C.fail();return v;}
 async function context(req,action){const v=requested(req,action);let claims;try{claims=await sessions.verify(sessions.bearer(req.headers.authorization));}catch{C.fail('gbp_association_session_required');}
  if(claims.sessionVersion!==1||claims.type==='cc_delegated_access'||!C.UUID.test(claims.jti)||!C.positive(claims.userId)||!Number.isSafeInteger(claims.exp*1000))C.fail('gbp_association_own_session_required');
  let auth;try{auth=await authorizeScope(req,'write');}catch{C.fail('scope_denied');}
  if(!auth.requested||auth.assignmentScope!=='clinic'||Number(auth.clinicId)!==Number(v.clinic_id)||!Array.isArray(auth.clinicIds)||auth.clinicIds.length!==1||Number(auth.clinicIds[0])!==Number(v.clinic_id))C.fail('scope_denied');
  const resolved=await resolveConnection(req,{allowLegacyUserFallback:false,metadataOnly:true});if(!resolved.connection||!C.positive(resolved.connection.id))C.fail('gbp_association_scope_unconfigured');
  return {clinicId:Number(v.clinic_id),scopeKey:'clinic:'+Number(v.clinic_id),connectionId:Number(resolved.connection.id),actorId:Number(claims.userId),sessionRef:claims.jti,sessionExpiresAt:claims.exp*1000};
 }
 const handler=action=>async(req,res)=>{res.set('Cache-Control','private, no-store');try{const v=requested(req,action),input=await context(req,action);let result;
  if(action==='prepare')result=await service.prepare(input,Object.fromEntries(['attemptId','sourceFingerprint','accountName','locationName',...(Object.hasOwn(v,'reviewDestinationChangeAccepted')?['reviewDestinationChangeAccepted']:[])].map(k=>[k,v[k]])));
  else if(['read','confirm','cancel'].includes(action))result=await service[action](input,req.params.attemptId);else result=await service[action](input);
  if(JSON.stringify(await context(req,action))!==JSON.stringify(input))C.fail('gbp_association_scope_changed');
  return res.status(result.attempt&& !['active','prepared','cancelled'].includes(result.attempt.state)?202:200).json({success:true,...result});
 }catch(error){return res.status(defaults.status(error)).json({success:false,error:defaults.safe(error)});}};
 router.get('/capabilities',handler('capabilities'));router.get('/candidates',handler('candidates'));router.get('/requests',handler('list'));router.post('/requests',handler('prepare'));router.get('/requests/:attemptId',handler('read'));router.post('/requests/:attemptId/confirm',handler('confirm'));router.post('/requests/:attemptId/cancel',handler('cancel'));return router;
}
module.exports={createRouter};
