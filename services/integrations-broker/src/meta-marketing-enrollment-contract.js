'use strict';
const {schema}=require('./contracts'),{fail}=require('./errors'),C=require('./meta-marketing-oauth-contract'),M=require('./meta-marketing-contract');
const OPERATIONS=Object.freeze(Object.fromEntries(['prepare','activate','status','revoke'].map(k=>[k,`meta.marketing.enrollment.${k}.v1`])));
const uuid={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'},digest={type:'string',pattern:'^[a-f0-9]{64}$'};
const assetPattern='^meta-(ad_account|facebook_page|instagram_business):[1-9][0-9]{0,29}$';
const validators={
  prepare:schema({enrollmentId:uuid,flowId:uuid,scopeDigest:digest,candidateDigest:digest,
    assetRefs:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'string',pattern:assetPattern}}}),
  activate:schema({enrollmentId:uuid,scopeDigest:digest,selectionDigest:digest}),
  status:schema({enrollmentId:uuid}),revoke:schema({enrollmentId:uuid}),
};
function roles(environment){
  if(!['dev','staging'].includes(environment))fail('invalid_request');
  return {gateway:`gateway:${environment}:meta-marketing-oauth`,control:`control:${environment}:meta-marketing-oauth`,
    reader:`${environment}:meta-marketing`,assetControl:`control:${environment}:meta-marketing`};
}
function assets(value){
  if(!Array.isArray(value)||!value.length||value.length>100)fail('invalid_request');
  const seen=new Set();
  for(const a of value){
    if(!C.exact(a,'assetRef,kind,id,parentPageId')||!new RegExp(assetPattern).test(a.assetRef)||a.assetRef!==`meta-${a.kind}:${a.id}`
      ||!M.graphId(a.id)||seen.has(a.assetRef)||(a.kind==='instagram_business'?!M.graphId(a.parentPageId):a.parentPageId!==null))fail('invalid_request');
    seen.add(a.assetRef);
  }
  return value.map(a=>({...a})).sort((a,b)=>a.assetRef.localeCompare(b.assetRef));
}
const identity=a=>({assetRef:a.assetRef,kind:a.kind,id:a.id,parentPageId:a.parentPageId});
const selectionDigest=(flow,binding,selected)=>C.hash(JSON.stringify([flow.id,flow.secret_digest,flow.scope_digest,flow.clinic_digest,C.fingerprint(binding),assets(selected)]));
function authorize({request,binding,principal},environment){
  const r=roles(environment),b=C.bindingFor(binding);
  if(request.tenantRef!=='clinic:'+b.clinicIds[0]||request.assetRef!=='meta-enroll:'+b.scopeKey
    ||![r.gateway,r.control].includes(principal.id)||principal.id===r.control&&![OPERATIONS.status,OPERATIONS.revoke].includes(request.operation))fail('scope_denied');
}
module.exports={OPERATIONS,validators,roles,assets,identity,selectionDigest,authorize};
