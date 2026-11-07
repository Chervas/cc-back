'use strict';
// The USER contract remains unchanged. A business binding is an owner-created
// capability, never a caller-supplied JSON marker or an implicit type conversion.
const C=require('./meta-marketing-oauth-contract'),B=require('./meta-marketing-business-issuer');
const business=B.isBinding;
const bindingFor=b=>business(b)?B.bindingFor(b):C.bindingFor(b);
const fingerprint=b=>business(b)?B.fingerprint(b):C.fingerprint(b);
const metadata=(v,b)=>business(b)?B.metadata(v,b):C.metadata(v,b);
const keys=b=>business(b)?B.keys(b):['appId','subjectId','tokenType','scopes','expiresAt','dataAccessExpiresAt','granularScopes'];
const graphVersion=b=>business(b)?bindingFor(b).businessLogin.graphVersion:require('./meta-marketing-contract').GRAPH_VERSION;
function inspected(raw,b,now,prior){return business(b)?B.forBinding(b).inspected(raw,b,now,prior?.issuerKind==='AGENCY_SYSTEM_USER'?{id:prior.subjectId,systemUserId:prior.systemUserId}:{id:prior?.subjectId,client_business_id:prior?.clientBusinessId}):C.inspected(raw,b,now);}
function authorize(context){if(!business(context.binding))return C.authorize(context);const b=bindingFor(context.binding),{request,principal}=context;
 if(request.tenantRef!=='clinic:'+b.clinicIds[0]||request.assetRef!=='meta-enroll:'+b.scopeKey||!/^(gateway|control):(dev|staging):meta-marketing-oauth$/.test(principal.id)||principal.id.startsWith('control:')&&![C.OPERATIONS.abort,C.OPERATIONS.status].includes(request.operation))require('./errors').fail('scope_denied');}
module.exports={authorize,business,bindingFor,fingerprint,metadata,keys,graphVersion,inspected};
