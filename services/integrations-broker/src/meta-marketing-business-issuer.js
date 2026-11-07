'use strict';
const B=require('./meta-marketing-business-contract'),A=require('./meta-marketing-agency-contract'),C=require('./meta-marketing-oauth-contract'),{fail}=require('./errors');
const family=value=>value?.cohort===A.COHORT?A:B;
const configs=value=>Array.isArray(value)?value:[value];
function config(value){const list=configs(value);if(!list.length||list.length>2)fail('invalid_request');const scopes=new Set();for(const v of list){family(v).config(v);for(const key of v.scopeKeys){if(scopes.has(key))fail('invalid_request');scopes.add(key);}}return value;}
function selected(base,value){config(value);const key=C.bindingFor(base).scopeKey,list=configs(value).filter(v=>v.scopeKeys.includes(key));if(list.length!==1)fail('scope_denied');return list[0];}
const forBinding=b=>A.isBinding(b)?A:B;
const isBinding=b=>A.isBinding(b)||B.isBinding(b);
function derive(base,value,assets=null){const v=selected(base,value);return family(v).derive(base,v,assets);}
const baseBinding=b=>A.baseBinding(B.baseBinding(b));
const bindingFor=b=>forBinding(b).bindingFor(b),metadata=(v,b)=>forBinding(b).metadata(v,b),fingerprint=b=>forBinding(b).fingerprint(b);
function authorize({request,binding,principal},environment){const b=bindingFor(binding),roles={gateway:`gateway:${environment}:meta-marketing-oauth`,control:`control:${environment}:meta-marketing-oauth`};
 if(request.tenantRef!=='clinic:'+b.clinicIds[0]||request.assetRef!=='meta-enroll:'+b.scopeKey||![roles.gateway,roles.control].includes(principal.id)||principal.id===roles.control&&![B.OPERATIONS.status,B.OPERATIONS.abort,B.OPERATIONS.drain].includes(request.operation))fail('scope_denied');}
const keys=b=>A.isBinding(b)?A.KEYS:['appId','subjectId','tokenType','clientBusinessId','configId','graphVersion','scopes','expiresAt','dataAccessExpiresAt','granularScopes'];
const identityKeys=metadata=>metadata?.issuerKind===A.ISSUER?['appId','subjectId','issuerKind','issuerBusinessId','systemUserId','configId','graphVersion']:['appId','subjectId','clientBusinessId','configId','graphVersion'];
module.exports={family,configs,config,selected,forBinding,isBinding,derive,baseBinding,bindingFor,metadata,fingerprint,authorize,keys,identityKeys};
