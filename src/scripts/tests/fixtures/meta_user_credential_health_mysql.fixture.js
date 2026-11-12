'use strict';
// Actual SQL grant, epoch, scope, lease and atomic pointer/proof transactions.
// The owner emits only closed fictitious health DTOs; no provider or sender runs.
const assert=require('node:assert/strict'),{DataTypes:D}=require('sequelize');
module.exports=async({models,sql,now,advance,report,baseline,untouched,renewalProbe})=>{
 const F=require('../../../services/metaMarketingEffectiveCredential.service'),M=require('../../../../services/integrations-broker/src/meta-marketing-credential-maintenance-contract');
 for(const[name,file]of[['MetaMarketingBusinessHandover','metamarketingbusinesshandover'],['MetaMarketingCredentialMaintenance','metamarketingcredentialmaintenance'],['MetaMarketingBusinessDrain','metamarketingbusinessdrain']])models[name]=require('../../../../models/'+file)(sql,D);
 await require('../../../../migrations/20261107223000-create-meta-marketing-business-continuity').up(sql.getQueryInterface(),require('sequelize'));
 const R=models.MetaMarketingEnrollmentRequest,P=models.MetaMarketingEffectiveCredential,T=models.MetaMarketingCredentialMaintenance;
 const enrollment=await R.findOne({where:{scope_key:'group:29',state:'active'},raw:true});assert(enrollment);
 const credentials=F.createEffectiveCredentials({models,now}),scopeKeys=()=>['group:29'],calls=[];
 let plan='healthy',expiresAt,interleave=null;
 const client={execute:async request=>{
  assert.equal(request.operation,M.OPERATIONS.health);calls.push(request);const fresh=await R.findByPk(enrollment.enrollment_id,{raw:true}),flow=await models.MetaMarketingOAuthRequest.findByPk(fresh.flow_id,{raw:true});
  const captured=await credentials.resolve(fresh,flow,null,{allowExpired:true});assert.equal(request.payload.expectedEpoch,captured.epoch);assert.equal(request.payload.expectedVersionId,captured.versionId);assert.equal(request.payload.expectedCandidateDigest,captured.digest);
  if(plan==='temporary')throw Object.assign(Error('FICTITIOUS_META_COOLDOWN'),{code:'rate_limited',retryAfterMs:7200000});
  const value={enrollmentId:fresh.enrollment_id,epoch:captured.epoch,versionId:captured.versionId,digest:captured.digest,verifiedAt:+now(),
   expiresAt:expiresAt===undefined?captured.candidate.expiresAt:expiresAt,dataAccessExpiresAt:null,healthy:plan==='healthy',reason:plan==='healthy'?null:'credential_revoked'};
  await interleave?.();return{requestId:request.requestId,data:value,replayed:false};
 }};
 const create=()=>require('../../../services/metaMarketingCredentialMaintenance.service').createMaintenance({models,client,now,enabled:()=>true,userHealthScopeKeys:scopeKeys});
 const before=await P.findByPk(enrollment.enrollment_id,{raw:true});
 await P.update({last_error:'credential_revoked',last_error_at:new Date(+now()-1000),last_healthy_at:new Date(+now()-7*3600000)},{where:{enrollment_id:enrollment.enrollment_id}});
 const initial=await P.findByPk(enrollment.enrollment_id,{raw:true});assert.equal(initial.epoch,before.epoch);
 const txs={pointer:[],proof:[]};
 P.addHook('beforeBulkUpdate','health-pointer-tx',options=>{if(Object.hasOwn(options.attributes,'last_healthy_at'))txs.pointer.push(options.transaction);});
 T.addHook('beforeBulkUpdate','health-proof-tx',options=>{if(Object.hasOwn(options.attributes,'health_metadata'))txs.proof.push(options.transaction);});
 T.addHook('beforeBulkUpdate','health-proof-rollback',options=>{if(options.attributes.health_metadata)throw Error('FICTITIOUS_HEALTH_PROOF_WRITE_FAILURE');});
 await create().run();T.removeHook('beforeBulkUpdate','health-proof-rollback');
 let row=await T.findOne({where:{enrollment_id:enrollment.enrollment_id,expected_epoch:initial.epoch},raw:true});assert(row);
 let pointer=await P.findByPk(enrollment.enrollment_id,{raw:true});assert.equal(pointer.last_error,'credential_revoked');assert.equal(row.health_metadata,null);assert.equal(pointer.epoch,initial.epoch);
 assert(txs.pointer.length&&txs.proof.length);assert.equal(txs.pointer[0],txs.proof[0]);
 report.checks.push('USER health uses the real grant/scope/epoch and one SQL transaction: injected proof-write failure rolls back the effective-pointer recovery, preserving denial and immutable credential/version');
 const worker=create();advance(1);assert.equal(await worker.checkHealth(row.maintenance_id),true);
 pointer=await P.findByPk(enrollment.enrollment_id,{raw:true});row=await T.findByPk(row.maintenance_id,{raw:true});
 assert.equal(pointer.last_error,null);assert.equal(pointer.epoch,initial.epoch);assert.equal(pointer.version_id,initial.version_id);assert.equal(JSON.parse(row.health_metadata).previousFailure.code,'credential_revoked');
 assert.equal(+row.health_next_at,+now()+21600000);assert.equal(row.rotate_sent_at,null);assert.equal(row.attempts,0);
 const status=await worker.getMaintenanceStatus(enrollment);assert.equal(status.automaticSupported,false);assert.equal(status.mechanism,'user_legacy');
 report.checks.push('Verified USER health recovers only the exact pinned version, keeps the prior failure in durable proof, schedules six-hour supervision and reports no automatic token renewal');
 const floor=+now()+1800000;expiresAt=floor;advance(1);assert.equal(await worker.checkHealth(row.maintenance_id),true);
 expiresAt=null;advance(1);assert.equal(await worker.checkHealth(row.maintenance_id),true);
 assert.equal((await credentials.getCredentialStatus(enrollment)).expiresAt,floor);
 plan='temporary';advance(1);const oldProof=(await T.findByPk(row.maintenance_id,{raw:true})).health_metadata;assert.equal(await worker.checkHealth(row.maintenance_id),false);
 assert.equal((await T.findByPk(row.maintenance_id,{raw:true})).health_metadata,oldProof);assert.equal((await credentials.getCredentialStatus(enrollment)).expiresAt,floor);
 plan='healthy';advance(1800001);expiresAt=initial.expires_at||before.expires_at||+now()+3600000;
 assert.equal(await worker.checkHealth(row.maintenance_id),false);const expired=await credentials.getCredentialStatus(enrollment);assert.equal(expired.healthKind,'expired');assert.equal(expired.expiresAt,floor);
 assert.equal((await T.findByPk(row.maintenance_id,{raw:true})).state,'human_required');
 report.checks.push('Actual recurring SQL observations preserve a finite floor through later null, provider cooldown and a later future deadline; once elapsed it stays expired and data readers remain closed on that epoch');
 // A real UI renewal on the isolated SQL model is the only extension tested.
 async function renew(){advance(1);const actor=renewalProbe.actorForGroup(29),result=await renewalProbe.service.begin(actor);
  await renewalProbe.service.callback({state:new URL(result.authUrl).searchParams.get('state'),code:'FICTITIOUS_USER_HEALTH_RENEWAL_'+result.requestId});
  const overview=await renewalProbe.service.overview(actor);assert.equal(overview.pending.canConfirm,true);await renewalProbe.service.confirm(actor,result.requestId,overview.pending.candidateDigest);
  await renewalProbe.service.reconcile(actor,result.requestId);return P.findByPk(enrollment.enrollment_id,{raw:true});}
 const renewed=await renew();assert.equal(renewed.epoch,Number(initial.epoch)+1);assert.notEqual(renewed.version_id,initial.version_id);
 assert.equal((await credentials.getCredentialStatus(enrollment)).healthKind,'healthy');assert((await credentials.getCredentialStatus(enrollment)).expiresAt>floor);
 await P.update({last_healthy_at:new Date(+now()-7*3600000),last_error:'credential_revoked',last_error_at:now()},{where:{enrollment_id:enrollment.enrollment_id}});
 await create().run();row=await T.findOne({where:{enrollment_id:enrollment.enrollment_id,expected_epoch:renewed.epoch},raw:true});assert(row);
 const oldPinnedProof=row.health_metadata;
 interleave=async()=>{interleave=null;await renew();};assert.equal(await create().checkHealth(row.maintenance_id),false);
 const latest=await P.findByPk(enrollment.enrollment_id,{raw:true});assert.equal(latest.epoch,Number(renewed.epoch)+1);assert.notEqual(latest.version_id,renewed.version_id);
 assert.equal((await T.findByPk(row.maintenance_id,{raw:true})).health_metadata,oldPinnedProof);
 assert.equal((await credentials.getCredentialStatus(enrollment)).healthKind,'healthy');
 report.checks.push('A genuine isolated UI OAuth renewal establishes a new epoch and may extend its lifetime; another renewal interleaved during an older health RPC fences the late result before it can overwrite the new pointer/proof');
 await create().run();const current=await T.findOne({where:{enrollment_id:enrollment.enrollment_id,expected_epoch:latest.epoch},raw:true});assert(current);
 const count=calls.length;await R.update({state:'revoke_pending'},{where:{enrollment_id:enrollment.enrollment_id}});
 assert.equal(await create().checkHealth(current.maintenance_id),false);assert.equal(calls.length,count);
 assert.equal(await baseline(),untouched);assert(calls.every(value=>value.operation===M.OPERATIONS.health));
 report.checks.push('Explicit grant retirement stops USER supervision before any owner RPC; original scope blocks, shared assets, claims and WhatsApp remain intact; no Ads, leads, mint, notification or provider send operation ran');
 P.removeHook('beforeBulkUpdate','health-pointer-tx');T.removeHook('beforeBulkUpdate','health-proof-tx');
 report.userHealth={realMysqlAuthority:true,realEpochCas:true,atomicPointerProof:true,ownerRpc:'closed fictitious DTO only',healthRpcCount:calls.length,rotationRpcCount:0,providerRequests:0};
};
