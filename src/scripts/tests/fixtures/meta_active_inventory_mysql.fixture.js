'use strict';
// Real isolated MySQL/AuthSession/MFA, real enrollment and two USER renewals,
// signed loopback Owner+SQLite+Secrets/Graph adapters. No external I/O.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{DataTypes:D}=require('sequelize');
module.exports=async({models,sql,sessions,service,enrollment,flow,api,request,token,now,report,wire,f,mfa,app,setAfterWire,commands})=>{
 const C=require('../../../services/metaMarketingEnrollment.contract'),F=require('../../../services/metaMarketingEffectiveCredential.service');
 const endpoint='/oauth/meta/marketing/enrollment',query='?assignment_scope=group&group_id=5';
 const reserved=await api('POST','',{flowId:flow.requestId,assetRefs:['meta-ad_account:301','meta-facebook_page:401']}),id=reserved.requestId;
 const run=()=>enrollment.run({enrollmentId:id}),current=()=>models.MetaMarketingEnrollmentRequest.findByPk(id,{raw:true});
 assert.equal((await run()).failed,0);const prepared=await current();assert.equal(prepared.state,'prepared');
 await api('POST','/'+id+'/confirmation',{selectionDigest:prepared.selection_digest});assert.equal((await run()).failed,0);assert.equal((await current()).state,'active');
 const originalClaims=await sessions.verify(token());assert.equal(originalClaims.userId,225);
 const originalFlow=JSON.stringify(await models.MetaMarketingOAuthRequest.findByPk(flow.requestId,{raw:true}));
 const baseline=async()=>JSON.stringify({enrollment:await current(),mappings:(await models.ClinicMetaAsset.findAll({raw:true,order:[['id','ASC']]}))
  .map(({metaAssetName,assetAvatarUrl,updatedAt,...assignment})=>assignment),
  grants:await models.MetaConnectionAssignment.findAll({raw:true,order:[['id','ASC']]}),claims:await models.MetaMarketingEnrollmentClaim.findAll({raw:true,order:[['asset_ref','ASC']]})});
 const enrolledBefore=await baseline();
 await models.AuthSession.update({state:'expired',ended_at:now()},{where:{session_id:originalClaims.jti}});await mfa();
 const fresh=await sessions.verify(token());assert.equal(fresh.userId,225);assert.notEqual(fresh.jti,originalClaims.jti);assert.deepEqual(fresh.amr,['pwd','email']);
 await assert.rejects(sessions.verifyReference({userId:225,sessionRef:originalClaims.jti,expiresAt:new Date(originalClaims.exp*1000)},{requireEmail:true}),{code:'auth_invalid'});
 for(const [name,file]of[['MetaMarketingCredentialRenewal','metamarketingcredentialrenewal'],['MetaMarketingEffectiveCredential','metamarketingeffectivecredential']])models[name]=require('../../../../models/'+file)(sql,D);
 await require('../../../../migrations/20261107203000-create-meta-marketing-credential-renewals').up(sql.getQueryInterface(),D);
 const renewal=require('../../../services/metaMarketingCredentialRenewal.service').createService({models,sessions,client:wire,now,enabled:()=>true,returnOrigin:'https://app.example.invalid'});
 app.use('/oauth/meta/marketing',require('../../../routes/metaMarketingCredentialRenewal.routes').createRouter({service:renewal,sessions}));
 const renewalEndpoint='/oauth/meta/marketing/credential-renewal';let version;
 for(let epoch=1;epoch<=2;epoch++){
  const begun=await request('POST',renewalEndpoint+query,{});assert.equal(begun.status,200,JSON.stringify(begun));
  await renewal.callback({state:new URL(begun.body.authUrl).searchParams.get('state'),code:'FICTITIOUS_REVIEW_RENEWAL_'+begun.body.requestId});
  const status=await request('GET',renewalEndpoint+query);assert.equal(status.body.pending.status,'staged',JSON.stringify(status));
  const confirmed=await request('POST',renewalEndpoint+'/'+begun.body.requestId+'/confirmation'+query,{candidateDigest:status.body.pending.candidateDigest});
  assert.equal(confirmed.status,200,JSON.stringify(confirmed));assert.equal(confirmed.body.credential.epoch,epoch);version=begun.body.requestId;
 }
 assert.equal(await baseline(),enrolledBefore);assert.equal(JSON.stringify(await models.MetaMarketingOAuthRequest.findByPk(flow.requestId,{raw:true})),originalFlow);
 const pointer=await models.MetaMarketingEffectiveCredential.findByPk(id,{raw:true});assert.equal(pointer.epoch,2);assert.equal(pointer.version_id,version);
 const overview=await api();assert.deepEqual(overview.discovery,{mode:'active',enrollmentId:id,epoch:2,versionId:version});
 assert.equal(overview.selection.connected,true);assert.equal(overview.selection.canConfirm,false);
 const assetsUrl=endpoint+'/'+id+'/assets'+query,oldUrl='/oauth/meta/marketing/authorization/'+flow.requestId+'/assets'+query;
 let before=f.state.awsCalls.length;
 const old=await request('POST',oldUrl,{});assert.equal(old.status,409);assert.equal(old.body.error,'meta_oauth_inventory_not_pending');assert.equal(f.state.awsCalls.length,before);
 const result=await request('POST',assetsUrl,{});assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.mode,'active');
 assert.equal(result.body.inventory.epoch,2);assert.equal(result.body.inventory.versionId,version);assert.equal(result.body.assignmentReview,undefined);
 assert.deepEqual(result.body.inventory.assets.map(C.E.identity),JSON.parse((await current()).assets));assert.equal(result.body.inventory.assets.length,2);
 const reads=f.state.awsCalls.slice(before).filter(v=>v.constructor.name==='GetSecretValueCommand'&&v.input.SecretId===f.binding.secretArn&&v.input.VersionId!==f.binding.metaMarketingOAuth.slotVersionId);
 assert(reads.length>0);assert(reads.every(v=>v.input.VersionId===version),'Active inventory must never borrow original or epoch1 provider credentials');
 assert.equal((await sessions.verify(token())).jti,fresh.jti);
 report.checks.push('Reviewer225 real fresh MFA session, expired original AuthSession, two USER renewals and active inventory traverse actual SQL+signed TLS Owner; only epoch2 Secrets version is borrowed and exactly2 granted assets return without selection/reservation');
 before=commands.length;assert.equal((await request('POST',assetsUrl,{token:'FICTITIOUS_REJECTED'})).status,400);assert.equal(commands.length,before);
 assert.equal((await request('POST',endpoint+'/'+id+'/assets?assignment_scope=group&group_id=6',{})).status,403);
 await models.UsuarioClinica.update({rol_clinica:'personaldeclinica'},{where:{id_usuario:225,id_clinica:71}});
 before=f.state.awsCalls.length;assert.equal((await request('POST',assetsUrl,{})).status,403);assert.equal(f.state.awsCalls.length,before);
 await models.UsuarioClinica.update({rol_clinica:'propietario'},{where:{id_usuario:225,id_clinica:71}});
 await models.MetaMarketingEnrollmentRequest.update({state:'revoke_pending'},{where:{enrollment_id:id}});
 before=f.state.awsCalls.length;assert.equal((await request('POST',assetsUrl,{})).status,409);assert.equal(f.state.awsCalls.length,before);
 await models.MetaMarketingEnrollmentRequest.update({state:'active'},{where:{enrollment_id:id}});
 setAfterWire(async command=>{if(command.operation===C.E.OPERATIONS.assets)await models.MetaMarketingEffectiveCredential.update({epoch:3},{where:{enrollment_id:id}});});
 const raced=await request('POST',assetsUrl,{});setAfterWire(null);assert.equal(raced.status,409,JSON.stringify(raced));assert.equal(raced.body.inventory,undefined);
 await models.MetaMarketingEffectiveCredential.update({epoch:2},{where:{enrollment_id:id}});
 assert.equal((await sessions.verify(token())).jti,fresh.jti);assert.equal(await baseline(),enrolledBefore);
 assert.equal(JSON.stringify(await models.MetaMarketingOAuthRequest.findByPk(flow.requestId,{raw:true})),originalFlow);
 const events=(await models.PlatformAuditEvent.findAll({raw:true})).map(row=>JSON.parse(row.body)).filter(value=>value.version===32);
 assert(events.some(v=>v.reason==='inventory_verified'&&v.actor.id==='225'&&v.sessionRef===fresh.jti&&v.epoch===2&&v.credentialVersionRef===version));
 assert(events.some(v=>v.reason==='access_changed'));assert.equal(events.filter(v=>v.reason==='inventory_verified').length,1);
 await models.AuthSession.update({state:'expired',ended_at:now()},{where:{session_id:fresh.jti}});
 before=f.state.awsCalls.length;assert.equal((await request('POST',assetsUrl,{})).status,401);assert.equal(f.state.awsCalls.length,before);
 report.checks.push('Old candidate URL returns409 without logout or provider I/O; current expired session remains401; foreign scope/WRITE/withdrawal deny before I/O and a post-I/O epoch change discards all results; original flow, grants, mapping identities and claims remain exact');
 report.activeInventory={actorId:225,epoch:2,assets:2,originalSessionExpired:true,currentSessionPreservedUntilExplicitTestExpiry:true,originalCredentialReads:0,providerNetworkCalls:0};
};
