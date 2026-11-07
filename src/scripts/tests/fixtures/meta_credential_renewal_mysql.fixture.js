'use strict';
// Actual SQL renewal orchestration, with a closed fake owner implementing the
// separately tested broker ABI. No provider or external database is involved.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{DataTypes:D}=require('sequelize');
module.exports=async({models,sql,actors,flows,now,advance,report,baseline,untouched,sessions})=>{
  const E=require('../../../services/metaMarketingEnrollment.contract'),C=require('../../../services/metaMarketingCredentialRenewal.contract');
  const F=require('../../../services/metaMarketingEffectiveCredential.service');
  models.MetaMarketingCredentialRenewal=require('../../../../models/metamarketingcredentialrenewal')(sql,D);
  models.MetaMarketingEffectiveCredential=require('../../../../models/metamarketingeffectivecredential')(sql,D);
  const migration=require('../../../../migrations/20261107203000-create-meta-marketing-credential-renewals');
  await migration.up(sql.getQueryInterface(),D);await assert.rejects(migration.down(),/history_must_be_preserved/);
  const credentials=F.createEffectiveCredentials({models,now}),bindings=require('../../../services/metaMarketingEnrollmentBinding.service').createBindings({models,sessions,now});
  const enrolled=await models.MetaMarketingEnrollmentRequest.findAll({where:{state:'active'},raw:true,order:[['scope_key','ASC']]});assert.equal(enrolled.length,2);
  const originalGrants=JSON.stringify(enrolled),originalFlows=JSON.stringify(await models.MetaMarketingOAuthRequest.findAll({raw:true,order:[['flow_id','ASC']]}));
  const claimsBefore=JSON.stringify(await models.MetaMarketingEnrollmentClaim.findAll({raw:true,order:[['asset_ref','ASC']]}));
  const ownerGrants=new Map(),ownerRenewals=new Map(),calls=[];let outcome='success',loseActivationAck=false;
  for(const raw of enrolled){const row=E.request(raw),flow=flows.find(value=>value.flow_id===row.flow_id),candidate=E.candidate(JSON.parse(flow.candidate_metadata),flow);
    ownerGrants.set(row.enrollment_id,{row,effective:{epoch:0,versionId:candidate.versionId,digest:candidate.digest,metadata:F.split(candidate)}});}
  const error=code=>Object.assign(Error(code),{code,httpStatus:409});
  function receipt(request){
    if(!request)return null;const grant=ownerGrants.get(request.enrollmentId);
    return {renewalId:request.renewalId,flowId:request.renewalId,enrollmentId:request.enrollmentId,status:request.status,
      grantDigest:E.hash('FICTITIOUS_GRANT_'+request.enrollmentId),assetSetDigest:F.assetSetDigest(grant.row.selected),
      effectiveCredential:structuredClone(grant.effective),candidate:request.candidate?structuredClone(request.candidate):null,activationApplied:request.status==='active'};
  }
  const client={async execute(command){
    const name=C.U.validate(command.operation,command.payload),payload=command.payload;calls.push({name,requestId:command.requestId,renewalId:payload.renewalId});
    let request=ownerRenewals.get(payload.renewalId),data;
    if(name==='begin'){
      const grant=ownerGrants.get(payload.enrollmentId);assert(grant);assert.equal(payload.expectedEpoch,grant.effective.epoch);assert.equal(payload.expectedVersionId,grant.effective.versionId);
      assert.equal(payload.expectedCandidateDigest,grant.effective.digest);assert.equal(payload.assetSetDigest,F.assetSetDigest(grant.row.selected));
      assert.equal(payload.scopeDigest,grant.row.scope_digest);assert.equal(payload.clinicSetDigest,E.hash(grant.row.clinic_ids));
      request={...payload,status:'awaiting',candidate:null,outcome};ownerRenewals.set(payload.renewalId,request);
      const flow=flows.find(value=>value.flow_id===grant.row.flow_id),params=new URLSearchParams({client_id:grant.row.app_id,redirect_uri:flow.redirect_uri,response_type:'code',scope:JSON.parse(flow.scopes).join(','),state:payload.state});
      data={renewalId:payload.renewalId,flowId:payload.renewalId,enrollmentId:payload.enrollmentId,expiresAt:payload.expiresAt,authUrl:'https://www.facebook.com/v24.0/dialog/oauth?'+params};
    }else if(!request){data={renewalId:payload.renewalId,flowId:payload.renewalId,enrollmentId:null,status:'not_found',grantDigest:null,assetSetDigest:null,effectiveCredential:null,candidate:null,activationApplied:false};
    }else if(name==='finish'){
      if(request.outcome!=='success'){request.status='rejected';throw error(request.outcome==='identity'?'oauth_identity_mismatch':'oauth_credentials_incomplete');}
      // Renewed credentials have a distinct provider lifetime from the original
      // two-hour fixture, so the other scope stays usable during handover QA.
      const metadata=structuredClone(ownerGrants.get(request.enrollmentId).effective.metadata);metadata.expiresAt=+now()+10800000;metadata.dataAccessExpiresAt=null;
      // A valid granular projection can exceed MySQL TEXT's 64KiB. Preserve
      // every target, including the complete selected asset set, without truncation.
      const targets=['301','302','303','401','501','502',...Array.from({length:994},(_,index)=>'9'.repeat(26)+String(1000+index))].sort();
      metadata.granularScopes=metadata.scopes.slice(0,3).map(scope=>({scope,targetIds:targets.slice()}));
      request.candidate={versionId:request.renewalId,digest:E.hash('FICTITIOUS_CANDIDATE_'+request.renewalId),metadata};request.status='staged';data=receipt(request);
    }else if(name==='activate'){
      const grant=ownerGrants.get(request.enrollmentId);
      if(request.status!=='active'){
        assert.equal(grant.effective.epoch,payload.expectedEpoch);assert.equal(request.candidate.digest,payload.candidateDigest);
        grant.effective={epoch:payload.expectedEpoch+1,...structuredClone(request.candidate)};request.status='active';
      }
      data=receipt(request);if(loseActivationAck){loseActivationAck=false;throw Object.assign(Error('broker_timeout'),{code:'broker_timeout'});}
    }else if(name==='abort'){
      if(request.status!=='active'){request.status='aborted';request.candidate=null;}data=receipt(request);
    }else data=receipt(request);
    return {requestId:command.requestId,replayed:false,data};
  }};
  let enabled=true;
  const service=require('../../../services/metaMarketingCredentialRenewal.service').createService({models,sessions,client,now,enabled:()=>enabled,returnOrigin:'https://app.example.invalid'});
  const begin=async(input,plan='success')=>{advance(1);outcome=plan;return service.begin(input);};
  const callback=async result=>service.callback({state:new URL(result.authUrl).searchParams.get('state'),code:'FICTITIOUS_RENEWAL_CODE_'+result.requestId});
  const rawRequest=id=>models.MetaMarketingCredentialRenewal.findByPk(id,{raw:true});
  const current=async id=>models.MetaMarketingEnrollmentRequest.findByPk(id,{raw:true});
  const digest=async id=>sql.transaction(async transaction=>(await bindings.committed(id,transaction)).digest);
  const originalDigests=new Map();for(const row of enrolled)originalDigests.set(row.enrollment_id,await digest(row.enrollment_id));

  const cancelled=await begin(actors[0]);await assert.rejects(service.begin(actors[0]),{code:'meta_renewal_busy'});
  assert.equal((await service.overview(actors[0])).credential.epoch,0);assert.equal(await digest(enrolled[0].enrollment_id),originalDigests.get(enrolled[0].enrollment_id));
  await service.cancel(actors[0],cancelled.requestId);assert.equal((await rawRequest(cancelled.requestId)).state,'cancelled');
  const disabledCallback=await begin(actors[0]);enabled=false;await callback(disabledCallback);enabled=true;
  assert.equal((await rawRequest(disabledCallback.requestId)).state,'cancelled');
  assert.equal(calls.filter(value=>value.name==='finish'&&value.renewalId===disabledCallback.requestId).length,0);
  const disabledStaged=await begin(actors[0]);await callback(disabledStaged);enabled=false;await service.reconcile(actors[0],disabledStaged.requestId);enabled=true;
  assert.equal((await rawRequest(disabledStaged.requestId)).state,'cancelled');
  assert.equal(calls.filter(value=>value.name==='activate'&&value.renewalId===disabledStaged.requestId).length,0);
  assert.equal(await models.MetaMarketingEffectiveCredential.count(),0);
  for(const plan of['identity','insufficient']){
    const rejected=await begin(actors[0],plan);await callback(rejected);await service.reconcile(actors[0],rejected.requestId);
    assert.equal((await rawRequest(rejected.requestId)).state,'rejected');assert.equal(await models.MetaMarketingEffectiveCredential.count(),0);
    assert.equal((await current(enrolled[0].enrollment_id)).state,'active');
  }
  report.checks.push('Renewal cancellation, closed-admission callbacks, wrong identity and insufficient new permissions preserve both active original grants, current credentials, exact asset claims and WhatsApp; one pending renewal per enrollment');

  const bs=ownerGrants.get(enrolled[1].enrollment_id);assert.equal(bs.row.selected.length,4);
  const changed=await begin(actors[1]);await callback(changed);let status=await service.overview(actors[1]);assert.equal(status.pending.canConfirm,true);
  assert.equal(status.credential.epoch,0);assert.equal(await digest(bs.row.enrollment_id),originalDigests.get(bs.row.enrollment_id));
  const refreshedActor={...actors[1],sessionExpiresAt:new Date(+actors[1].sessionExpiresAt+3600000)};
  assert.equal((await service.overview(refreshedActor)).pending.canConfirm,true);
  await assert.rejects(service.confirm({...refreshedActor,sessionRef:randomUUID()},changed.requestId,status.pending.candidateDigest),{code:'meta_renewal_session_required',httpStatus:409});
  await assert.rejects(service.confirm({...refreshedActor,sessionExpiresAt:new Date(+actors[1].sessionExpiresAt-1000)},changed.requestId,status.pending.candidateDigest),{code:'meta_renewal_session_required',httpStatus:409});
  loseActivationAck=true;await service.confirm(refreshedActor,changed.requestId,status.pending.candidateDigest);
  assert.equal((await rawRequest(changed.requestId)).state,'activate_pending');assert.equal(await models.MetaMarketingEffectiveCredential.count(),0);
  await service.reconcile(actors[1],changed.requestId);status=await service.overview(actors[1]);assert.equal(status.credential.epoch,1);assert.equal(status.pending.status,'active');
  const largePointer=await models.MetaMarketingEffectiveCredential.findByPk(bs.row.enrollment_id,{raw:true});
  assert(Buffer.byteLength(largePointer.candidate_metadata)>65535);assert.equal(JSON.parse(largePointer.candidate_metadata).granularScopes[0].targetIds.length,1000);
  assert.equal(calls.filter(value=>value.name==='activate'&&value.renewalId===changed.requestId).length,1);
  await service.reconcile(actors[1],changed.requestId);assert.equal((await credentials.getCredentialStatus(await current(bs.row.enrollment_id),{})).epoch,1);
  assert.equal(await digest(bs.row.enrollment_id),originalDigests.get(bs.row.enrollment_id));
  assert.equal(await credentials.recordFailure({enrollmentId:bs.row.enrollment_id,epoch:0,versionId:bs.row.flow_id},{code:'credential_revoked'}),false);
  assert.equal((await credentials.getCredentialStatus(await current(bs.row.enrollment_id),{})).healthKind,'healthy');
  report.checks.push('BS4-asset renewal keeps the original grant digest and lead generation; owner CAS ACK loss reconciles exactly once without a second activation or code exchange; late old-version failures cannot mark the new credential unhealthy');

  const epochOne=await credentials.getCredentialStatus(await current(bs.row.enrollment_id),{});
  await credentials.recordFailure({enrollmentId:bs.row.enrollment_id,epoch:1,versionId:epochOne.versionId},{code:'credential_revoked'});
  assert.equal((await credentials.getCredentialStatus(await current(bs.row.enrollment_id),{})).healthKind,'permission_lost');
  const rejected=await begin(actors[1],'insufficient');await callback(rejected);await service.reconcile(actors[1],rejected.requestId);
  assert.equal((await credentials.getCredentialStatus(await current(bs.row.enrollment_id),{})).healthKind,'permission_lost');
  const restored=await begin(actors[1]);await callback(restored);status=await service.overview(actors[1]);await service.confirm(actors[1],restored.requestId,status.pending.candidateDigest);
  assert.equal((await credentials.getCredentialStatus(await current(bs.row.enrollment_id),{})).epoch,2);
  assert.equal((await credentials.getCredentialStatus(await current(bs.row.enrollment_id),{})).healthKind,'healthy');

  const auditRepository=require('../../../services/platformAudit.repository'),auditEvent=require('../../../../services/platform-audit/src/event');
  const delivered=await auditRepository.drain(auditRepository.createRepository(models.PlatformAuditEvent),{
    write:async row=>({key:auditEvent.keyFor(row),digest:row.digest,versionId:'FICTITIOUS_RENEWAL_DELIVERY_ACK'})},{now,limit:100});
  assert.equal(delivered.failed,0);assert.equal(delivered.pending,0);
  advance(7200001);const freshActor={...actors[0],sessionRef:randomUUID(),sessionExpiresAt:new Date(+now()+10800000)};
  assert.equal((await service.overview(freshActor)).credential.expired,true);assert.equal((await service.overview(freshActor)).canRenew,true);
  const expiredMetadata=require('../../../services/metaConnectionMetadata.service').createMetaDataAccessRepository(models,{now,enabled:()=>true,
    broker:{prepare:()=>assert.fail('Expired credential must not be advertised as usable data access')}});
  assert.equal(await expiredMetadata({scopeKey:'group:28',clinicIds:[1,70]}),null);
  const worker=require('../../../services/metaMarketingEnrollment.service').createService({models,sessions,now,workerEnabled:()=>true,client,oauth:{}});
  await worker.run({enrollmentId:enrolled[0].enrollment_id});assert.equal((await current(enrolled[0].enrollment_id)).state,'active');
  const arriaga=await begin(freshActor);await callback(arriaga);status=await service.overview(freshActor);
  models.PlatformAuditEvent.addHook('beforeCreate','renewal-ack-failure',value=>{if(JSON.parse(value.body).reason==='meta_credential_renewal_activated')throw Error('FICTITIOUS_RENEWAL_SQL_ACK_FAILURE');});
  try{await service.confirm(freshActor,arriaga.requestId,status.pending.candidateDigest);}finally{models.PlatformAuditEvent.removeHook('beforeCreate','renewal-ack-failure');}
  assert.equal((await rawRequest(arriaga.requestId)).state,'activate_pending');await service.reconcile(freshActor,arriaga.requestId);
  assert.equal((await service.overview(freshActor)).credential.expired,false);assert.equal((await rawRequest(arriaga.requestId)).state,'active');
  assert.equal(calls.filter(value=>value.name==='activate'&&value.renewalId===arriaga.requestId).length,1);
  assert.equal(await digest(enrolled[0].enrollment_id),originalDigests.get(enrolled[0].enrollment_id));
  report.checks.push('Expired credential renewal uses a fresh verified UI session without Root preparation, never retires the grant for token age, preserves the old pointer on SQL audit failure and reconciles the confirmed owner receipt after rollback');

  assert.equal(JSON.stringify(await models.MetaMarketingEnrollmentClaim.findAll({raw:true,order:[['asset_ref','ASC']]})),claimsBefore);
  assert.equal(JSON.stringify(await models.MetaMarketingOAuthRequest.findAll({raw:true,order:[['flow_id','ASC']]})),originalFlows);
  const finalGrants=await models.MetaMarketingEnrollmentRequest.findAll({where:{state:'active'},raw:true,order:[['scope_key','ASC']]});
  const immutable=rows=>rows.map(row=>Object.fromEntries(['enrollment_id','flow_id','scope_key','clinic_ids','assets','mapping_ids','candidate_digest','flow_digest','selection_digest'].map(key=>[key,row[key]])));
  assert.deepEqual(immutable(finalGrants),immutable(JSON.parse(originalGrants)));assert.equal(await baseline(),untouched);
  for(const row of finalGrants){const pointer=await models.MetaMarketingEffectiveCredential.findByPk(row.enrollment_id,{raw:true});assert(pointer);assert(pointer.renewal_id);}
  assert.equal(await models.MetaMarketingEffectiveCredential.count(),2);
  report.renewal={enrollments:2,bsAssets:4,activeEpochs:[1,2],originalGrantAndFlowsUnchanged:true,claimsUnchanged:true,whatsappUnchanged:true,providerRequests:0};
  return {service,actorForGroup:group=>({...actors[group===28?0:1],sessionRef:randomUUID(),sessionExpiresAt:new Date(+now()+10800000)})};
};
