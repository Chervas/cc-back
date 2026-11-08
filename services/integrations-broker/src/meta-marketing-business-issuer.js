'use strict';
const B=require('./meta-marketing-business-contract'),A=require('./meta-marketing-agency-contract'),C=require('./meta-marketing-oauth-contract'),M=require('./meta-marketing-contract'),{fail}=require('./errors');
function family(value){if([A.COHORT,A.PAID_COHORT].includes(value?.cohort))return A;if([B.COHORT,B.PAID_COHORT].includes(value?.cohort))return B;fail('invalid_request');}
const registry=value=>!Array.isArray(value)&&C.exact(value,'active,history')?value:{active:Array.isArray(value)?value:[value],history:[]};
const entries=value=>{const r=registry(value);if(!Array.isArray(r.active)||!Array.isArray(r.history))fail('invalid_request');return [...r.active.map(configuration=>({appId:null,configuration})),...r.history];};
const configs=value=>entries(value).map(entry=>entry.configuration);
function config(value){const r=registry(value);if(!Array.isArray(r.active)||r.active.length>2||!Array.isArray(r.history)||r.history.length>4||r.active.length+r.history.length<1||r.active.length+r.history.length>4)fail('invalid_request');
 for(const entry of r.history)if(!C.exact(entry,'appId,configuration')||!M.graphId(entry.appId))fail('invalid_request');
 const scopes=new Set(),ids=new Set();for(const v of configs(value)){family(v).config(v);if(ids.has(v.configId))fail('invalid_request');ids.add(v.configId);}
 for(const v of r.active)for(const key of v.scopeKeys){if(scopes.has(key))fail('invalid_request');scopes.add(key);}return value;}
function selected(base,value){config(value);const key=C.bindingFor(base).scopeKey,list=registry(value).active.filter(v=>v.scopeKeys.includes(key));if(list.length!==1)fail('scope_denied');return list[0];}
const forBinding=b=>A.isBinding(b)?A:B;
const isBinding=b=>A.isBinding(b)||B.isBinding(b);
function derive(base,value,assets=null){const v=selected(base,value);return family(v).derive(base,v,assets);}
// Historical entries are only a closed registry of already pinned credentials.
// They never participate in target selection or confer authority from raw scopes.
function forCredential(base,value,metadata,assets=null){config(value);const key=C.bindingFor(base).scopeKey;
 const list=entries(value).filter(entry=>entry.appId===null||entry.appId===C.bindingFor(base).appId).map(entry=>entry.configuration).filter(v=>v.configId===metadata?.configId&&v.scopeKeys.includes(key)&&(family(v)===A)===(metadata?.issuerKind===A.ISSUER));
 if(list.length!==1)fail('scope_denied');const binding=family(list[0]).derive(base,list[0],assets);family(list[0]).metadata(metadata,binding);return binding;}
function pinned(base,value,digest,assets=null){config(value);if(!/^[a-f0-9]{64}$/.test(digest||''))fail('scope_denied');const key=C.bindingFor(base).scopeKey;
 const list=entries(value).filter(entry=>entry.appId===null||entry.appId===C.bindingFor(base).appId).map(entry=>entry.configuration).filter(v=>v.scopeKeys.includes(key)&&fingerprint(family(v).derive(base,v))===digest);
 if(list.length!==1)fail('scope_denied');return family(list[0]).derive(base,list[0],assets);}
const baseBinding=b=>A.baseBinding(B.baseBinding(b));
const bindingFor=b=>forBinding(b).bindingFor(b),metadata=(v,b)=>forBinding(b).metadata(v,b),fingerprint=b=>forBinding(b).fingerprint(b);
function authorize({request,binding,principal},environment){const b=bindingFor(binding),roles={gateway:`gateway:${environment}:meta-marketing-oauth`,control:`control:${environment}:meta-marketing-oauth`};
 if(request.tenantRef!=='clinic:'+b.clinicIds[0]||request.assetRef!=='meta-enroll:'+b.scopeKey||![roles.gateway,roles.control].includes(principal.id)||principal.id===roles.control&&![B.OPERATIONS.status,B.OPERATIONS.abort,B.OPERATIONS.drain].includes(request.operation))fail('scope_denied');}
const keys=b=>A.isBinding(b)?A.KEYS:['appId','subjectId','tokenType','clientBusinessId','configId','graphVersion','scopes','expiresAt','dataAccessExpiresAt','granularScopes'];
const identityKeys=metadata=>metadata?.issuerKind===A.ISSUER?['appId','subjectId','issuerKind','issuerBusinessId','systemUserId','configId','graphVersion']:['appId','subjectId','clientBusinessId','configId','graphVersion'];
module.exports={family,configs,config,selected,forBinding,isBinding,derive,forCredential,pinned,baseBinding,bindingFor,metadata,fingerprint,authorize,keys,identityKeys};
