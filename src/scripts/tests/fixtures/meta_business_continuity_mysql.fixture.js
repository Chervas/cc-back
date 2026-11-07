'use strict';
// Real SQL authority/CAS/leases and a closed metadata-only fake owner. The
// provider/business owner itself is exercised separately by the broker suite.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{DataTypes:D,Op}=require('sequelize');
module.exports=async({models,sql,now,advance,report,baseline,untouched})=>{
  const C=require('../../../services/metaMarketingBusiness.contract'),E=require('../../../services/metaMarketingEnrollment.contract'),F=require('../../../services/metaMarketingEffectiveCredential.service'),M=require('../../../../services/integrations-broker/src/meta-marketing-credential-maintenance-contract');
  const agencyMode=process.env.META_BUSINESS_AGENCY_TEST==='1';
  const configuration=scopeKey=>agencyMode&&scopeKey==='group:29'?{issuerKind:C.A.ISSUER,issuerBusinessId:'348',configId:'222',graphVersion:'v27.0'}:{issuerKind:'BISU',issuerBusinessId:null,configId:'111',graphVersion:'v24.0'};
  for(const[name,file]of[['MetaMarketingBusinessHandover','metamarketingbusinesshandover'],['MetaMarketingCredentialMaintenance','metamarketingcredentialmaintenance'],['MetaMarketingBusinessDrain','metamarketingbusinessdrain']])models[name]=require('../../../../models/'+file)(sql,D);
  await require('../../../../migrations/20261107223000-create-meta-marketing-business-continuity').up(sql.getQueryInterface(),require('sequelize'));
  models.UsuarioClinica=sql.define('BusinessTestMembership',{id:{type:D.INTEGER,primaryKey:true,autoIncrement:true},id_usuario:D.INTEGER,id_clinica:D.INTEGER,rol_clinica:D.STRING,estado_invitacion:D.STRING},{timestamps:false});await models.UsuarioClinica.sync();
  await models.UsuarioClinica.bulkCreate([1,70,66,72].map(id_clinica=>({id_usuario:99,id_clinica,rol_clinica:id_clinica===72?'agencia':'propietario',estado_invitacion:'aceptada'})));
  models.JobRequest=require('../../../../models/jobrequest')(sql,D);for(const field of Object.values(models.JobRequest.rawAttributes))delete field.references;models.JobRequest.refreshAttributes();await models.JobRequest.sync();
  models.LeadIntake=sql.define('BusinessTestLead',{id:{type:D.INTEGER,primaryKey:true},clinica_id:D.INTEGER,external_source:D.STRING,external_id:D.STRING},{timestamps:false});await models.LeadIntake.sync();
  const sessions={verifyReference:async(reference,options)=>{assert.equal(reference.userId,99);assert.equal(options.requireEmail,true);assert(options.transaction);if(+reference.expiresAt<=+now())throw Object.assign(Error('auth_invalid'),{code:'auth_invalid'});}};
  const actor=group=>({scopeKey:'group:'+group,actorId:99,sessionRef:randomUUID(),sessionExpiresAt:new Date(+now()+10800000)});
  const inputs=[actor(28),actor(29)],credentials=F.createEffectiveCredentials({models,now}),grants=new Map(),handovers=new Map(),maintenances=new Map(),calls=[],previousStatus=new Map(),previousAlerts=new Map();
  const initial=await models.MetaMarketingEnrollmentRequest.findAll({where:{state:'active'},order:[['scope_key','ASC']],raw:true});assert.equal(initial.length,2);
  const original=initial.map(C.freeze),recoveries=JSON.stringify(await models.MetaMarketingRecovery.findAll({raw:true,order:[['recovery_id','ASC']]}));
  for(const row of initial){const flow=await models.MetaMarketingOAuthRequest.findByPk(row.flow_id,{raw:true}),value=await credentials.resolve(row,flow,null,{allowExpired:true});grants.set(row.enrollment_id,{row:E.request(row),effective:{epoch:value.epoch,versionId:value.versionId,digest:value.digest,metadata:F.split(value.candidate)},status:'active'});
    const status=await credentials.getCredentialStatus(row),maintenance=await require('../../../services/metaMarketingCredentialMaintenance.service').createMaintenance({models,now}).getMaintenanceStatus(row);previousStatus.set(row.enrollment_id,status);
    previousAlerts.set(row.enrollment_id,require('../../../lib/metaMarketingCredentialAlerts').alertsFromStatus(status,+now(),maintenance)[0]);
  }
  let plan='success',loseBusinessAck=false,loseMaintenanceAck=false,temporaryMaintenance=false,alwaysTemporaryMaintenanceId=null,healthPlan='healthy',healthTarget=null;
  const error=code=>Object.assign(Error(code),{code,httpStatus:409});
  const ownerDigest=id=>E.hash('FICTITIOUS_OWNER_GRANT_'+id),businessView=request=>({handoverId:request.handoverId,flowId:request.handoverId,newEnrollmentId:request.handoverId,oldEnrollmentId:request.oldEnrollmentId,status:request.status,oldGrantDigest:ownerDigest(request.oldEnrollmentId),assetSetDigest:request.assetSetDigest,candidate:request.candidate,newEnrollment:request.newEnrollment??null,handoverApplied:request.status==='active',drain:request.drain??null});
  const maintenanceView=request=>({maintenanceId:request.maintenanceId,enrollmentId:request.enrollmentId,status:request.status,effectiveCredential:structuredClone(grants.get(request.enrollmentId).effective),candidate:request.candidate??null,activationApplied:request.status==='active'});
  const client={async execute(command){
    const isBusiness=Object.values(C.B.OPERATIONS).includes(command.operation),name=isBusiness?C.B.validate(command.operation,command.payload):M.validate(command.operation,command.payload),p=command.payload;
    calls.push({business:isBusiness,name,requestId:command.requestId,id:p.handoverId??p.maintenanceId});let data;
    if(isBusiness){let r=handovers.get(p.handoverId);
      if(name==='begin'){
        if(plan==='begin_unavailable')throw Object.assign(Error('broker_timeout'),{code:'broker_timeout'});
        const old=grants.get(p.oldEnrollmentId);assert.equal(old.status,'active');assert.equal(p.expectedEpoch,old.effective.epoch);assert.equal(p.expectedVersionId,old.effective.versionId);assert.equal(p.expectedCandidateDigest,old.effective.digest);assert.equal(p.assetSetDigest,F.assetSetDigest(old.row.selected));
        r={...p,status:'awaiting',candidate:null,plan};handovers.set(p.handoverId,r);
        const params=new URLSearchParams({client_id:old.row.app_id,config_id:'111',redirect_uri:'https://auth.example.invalid/oauth/meta/marketing/callback',response_type:'code',state:p.state,override_default_response_type:'true'});
        // The native source flow's approved redirect is the only permitted URI.
        const journal=await models.MetaMarketingBusinessHandover.findByPk(p.handoverId,{raw:true});params.set('redirect_uri',journal.redirect_uri);params.set('config_id',journal.config_id);r.issuerKind=journal.issuer_kind;r.issuerBusinessId=journal.issuer_business_id;r.configId=journal.config_id;r.graphVersion=journal.graph_version;
        data={handoverId:p.handoverId,flowId:p.handoverId,newEnrollmentId:p.handoverId,oldEnrollmentId:p.oldEnrollmentId,oldGrantDigest:ownerDigest(p.oldEnrollmentId),authUrl:'https://www.facebook.com/'+journal.graph_version+'/dialog/oauth?'+params,expiresAt:p.expiresAt};
      }else if(!r){if(name==='abort')throw error('scope_denied');data={handoverId:p.handoverId,flowId:p.handoverId,newEnrollmentId:null,oldEnrollmentId:null,status:'not_found',oldGrantDigest:null,assetSetDigest:null,candidate:null,newEnrollment:null,handoverApplied:false,drain:null};
      }else if(name==='finish'){
        if(r.plan==='insufficient'){r.status='rejected';throw error('oauth_credentials_incomplete');}
        const old=grants.get(r.oldEnrollmentId),group=old.row.scope_key.split(':')[1],subjectId=r.plan==='identity'?old.row.meta_user_id:'8'+group;
        const metadata=r.issuerKind===C.A.ISSUER&&r.plan!=='wrong_issuer'?{appId:old.row.app_id,subjectId,tokenType:'SYSTEM_USER',issuerKind:C.A.ISSUER,issuerBusinessId:r.plan==='wrong_provider'?'999':r.issuerBusinessId,systemUserId:subjectId,configId:r.configId,graphVersion:r.graphVersion,scopes:[...C.A.SCOPES],expiresAt:+now()+60*86400000,dataAccessExpiresAt:null,granularScopes:[]}
          :{appId:old.row.app_id,subjectId,tokenType:'SYSTEM_USER',clientBusinessId:'9'+group,configId:r.configId,graphVersion:r.graphVersion,scopes:[...C.B.SCOPES],expiresAt:+now()+60*86400000,dataAccessExpiresAt:null,granularScopes:[]};
        r.candidate={versionId:r.handoverId,digest:E.hash('FICTITIOUS_BUSINESS_'+r.handoverId),metadata};r.status='staged';
        if(r.plan==='processing'){r.delayedCandidate=r.candidate;r.candidate=null;r.status='processing';r.remainingPolls=2;}
        data=businessView(r);
      }else if(name==='drain'){r.drain={closed:true,receiptRefs:[],receiptSetDigest:C.B.drainDigest(r.handoverId,ownerDigest(r.oldEnrollmentId),[]),activeOperations:0};data=businessView(r);
      }else if(name==='activate'){
        const old=grants.get(r.oldEnrollmentId);assert.equal(p.drainDigest,E.hash(JSON.stringify([r.handoverId,ownerDigest(r.oldEnrollmentId),[]])));
        if(r.status!=='active'){
          assert.equal(old.status,'active');old.status='superseded';r.status='active';
          r.newEnrollment={enrollmentId:r.handoverId,flowId:r.handoverId,scopeKey:old.row.scope_key,scopeDigest:r.scopeDigest,candidateDigest:r.candidate.digest,selectionDigest:E.hash('FICTITIOUS_BUSINESS_SELECTION_'+r.handoverId),clinicSetDigest:r.clinicSetDigest,assets:old.row.selected,status:'active',accessBlocked:false,preparedAt:+now(),activatedAt:+now()};
          const journal=await models.MetaMarketingBusinessHandover.findByPk(r.handoverId,{raw:true});
          grants.set(r.handoverId,{row:{...old.row,enrollment_id:r.handoverId,flow_id:r.handoverId,meta_user_id:r.candidate.metadata.subjectId,scope_digest:r.scopeDigest},effective:{epoch:0,...structuredClone(r.candidate)},status:'active',journal});
        }
        data=businessView(r);if(loseBusinessAck){loseBusinessAck=false;throw Object.assign(Error('broker_timeout'),{code:'broker_timeout'});}
      }else if(name==='abort'){if(r.status!=='active'){r.status='aborted';r.candidate=null;r.drain=null;}data=businessView(r);
      }else{if(r.status==='processing'&&r.delayedCandidate&&--r.remainingPolls<=0){r.candidate=r.delayedCandidate;r.status='staged';}data=businessView(r);}
    }else{let r=maintenances.get(p.maintenanceId);
      if(name==='health'){
        const grant=grants.get(p.enrollmentId);assert.equal(p.expectedEpoch,grant.effective.epoch);assert.equal(p.expectedVersionId,grant.effective.versionId);assert.equal(p.expectedCandidateDigest,grant.effective.digest);
        if(healthPlan==='temporary')throw Object.assign(Error('provider_timeout'),{code:'provider_timeout'});
        const denied=healthPlan==='permission_lost'&&p.enrollmentId===healthTarget;
        data={enrollmentId:p.enrollmentId,epoch:grant.effective.epoch,versionId:grant.effective.versionId,digest:grant.effective.digest,verifiedAt:+now(),expiresAt:grant.effective.metadata.expiresAt,dataAccessExpiresAt:grant.effective.metadata.dataAccessExpiresAt,healthy:!denied,reason:denied?'permissions_lost':null};
      }else if(name==='status')data=r?maintenanceView(r):{maintenanceId:p.maintenanceId,enrollmentId:null,status:'not_found',effectiveCredential:null,candidate:null,activationApplied:false};
      else{
        if(temporaryMaintenance||p.enrollmentId===alwaysTemporaryMaintenanceId){const retryAfterMs=temporaryMaintenance?7200000:0;temporaryMaintenance=false;throw Object.assign(error('rate_limited'),{retryAfterMs,httpStatus:429});}
        const grant=grants.get(p.enrollmentId);assert.equal(grant.status,'active');
        if(!r){assert.equal(p.expectedEpoch,grant.effective.epoch);assert.equal(p.expectedVersionId,grant.effective.versionId);assert.equal(p.expectedCandidateDigest,grant.effective.digest);
          const metadata={...grant.effective.metadata,expiresAt:+now()+60*86400000};r={...p,status:'active',candidate:{versionId:p.maintenanceId,digest:E.hash('FICTITIOUS_MAINTENANCE_'+p.maintenanceId),metadata}};maintenances.set(p.maintenanceId,r);grant.effective={epoch:p.expectedEpoch+1,...structuredClone(r.candidate)};
        }
        data=maintenanceView(r);if(loseMaintenanceAck){loseMaintenanceAck=false;throw Object.assign(Error('broker_timeout'),{code:'broker_timeout'});}
      }
    }
    return {requestId:command.requestId,replayed:false,data:structuredClone(data)};
  }};
  let businessEnabled=true;
  const service=require('../../../services/metaMarketingBusiness.service').createService({models,sessions,client,now,enabled:()=>businessEnabled,configuration,returnOrigin:'https://app.example.invalid'});
  const confirmationFrom=(pending,changes={})=>({candidateDigest:pending.candidateDigest,clientBusinessId:pending.clientBusinessId,subjectId:pending.subjectId,issuerKind:pending.issuerKind,providerBusinessId:pending.providerBusinessId,...changes});
  const begin=async(input,value='success')=>{advance(1);plan=value;return service.begin(input);},callback=async value=>service.callback({state:new URL(value.authUrl).searchParams.get('state'),code:'FICTITIOUS_BUSINESS_CODE_'+value.requestId});
  const loadH=id=>models.MetaMarketingBusinessHandover.findByPk(id,{raw:true});
  await assert.rejects(begin(inputs[0],'begin_unavailable'),{code:'broker_timeout'});
  const missingOwner=await models.MetaMarketingBusinessHandover.findOne({where:{pending_scope_key:'group:28'},raw:true});await service.reconcile(inputs[0],missingOwner.handover_id);assert.equal((await loadH(missingOwner.handover_id)).state,'rejected');
  const disabled=await begin(inputs[0]);businessEnabled=false;await callback(disabled);businessEnabled=true;
  assert.equal((await loadH(disabled.requestId)).state,'cancelled');assert.equal(calls.filter(value=>value.business&&value.name==='finish'&&value.id===disabled.requestId).length,0);
  const sessionProbe=await begin(inputs[0]);await callback(sessionProbe);
  const jwt=require('jsonwebtoken'),fakeSigningKey='FICTITIOUS_LOCAL_TEST_SIGNING_KEY_NOT_A_PROVIDER_TOKEN';
  const signed=jwt.sign({userId:99,sessionVersion:1,iat:Math.floor(+now()/1000),exp:Math.floor((+inputs[0].sessionExpiresAt+3600000)/1000)},fakeSigningKey,{algorithm:'HS256',jwtid:inputs[0].sessionRef});
  const claims=jwt.verify(signed,fakeSigningKey,{algorithms:['HS256'],clockTimestamp:Math.floor(+now()/1000)});
  const refreshed={scopeKey:inputs[0].scopeKey,actorId:claims.userId,sessionRef:claims.jti,sessionExpiresAt:new Date(claims.exp*1000)},probe=await service.overview(refreshed);
  assert.equal(probe.pending.canConfirm,true);
  const confirmation=confirmationFrom(probe.pending);
  await assert.rejects(service.confirm({...refreshed,sessionRef:randomUUID()},sessionProbe.requestId,confirmation),{code:'meta_business_session_required',httpStatus:409});
  await assert.rejects(service.confirm({...refreshed,sessionExpiresAt:new Date(+inputs[0].sessionExpiresAt-1000)},sessionProbe.requestId,confirmation),{code:'meta_business_session_required',httpStatus:409});
  const future=()=>new Date(+inputs[0].sessionExpiresAt+1),futureSessions={verifyReference:async(reference,options)=>{if(+reference.expiresAt<=+future())throw Object.assign(Error('auth_invalid'),{code:'auth_invalid'});return sessions.verifyReference(reference,options);}};
  const futureService=require('../../../services/metaMarketingBusiness.service').createService({models,sessions:futureSessions,client,now:future,enabled:()=>true,configuration,returnOrigin:'https://app.example.invalid'});
  await assert.rejects(futureService.confirm(refreshed,sessionProbe.requestId,confirmation),{code:'meta_business_session_required',httpStatus:409});
  await service.cancel(refreshed,sessionProbe.requestId);
  for(const value of['cancel','identity','insufficient']){
    const start=await begin(inputs[0],value==='cancel'?'success':value);await callback(start);
    if(value==='cancel')await service.cancel(inputs[0],start.requestId);else await service.reconcile(inputs[0],start.requestId);
    assert(['cancelled','rejected'].includes((await loadH(start.requestId)).state));assert.equal((await models.MetaMarketingEnrollmentRequest.findByPk(initial[0].enrollment_id)).state,'active');
  }
  if(agencyMode)for(const value of['wrong_issuer','wrong_provider']){const start=await begin(inputs[1],value);await callback(start);await service.reconcile(inputs[1],start.requestId);assert.equal((await loadH(start.requestId)).state,'rejected');assert.equal((await models.MetaMarketingEnrollmentRequest.findByPk(initial[1].enrollment_id)).state,'active');}
  if(agencyMode){const staged=await begin(inputs[1],'processing');await callback(staged);assert.equal((await service.overview(inputs[1])).pending.status,'processing');assert.equal((await service.overview(inputs[1])).pending.canConfirm,false);await callback(staged);assert.equal((await service.overview(inputs[1])).pending.canConfirm,true);assert.equal(calls.filter(value=>value.business&&value.name==='finish'&&value.id===staged.requestId).length,1);await service.cancel(inputs[1],staged.requestId);assert.equal((await loadH(staged.requestId)).state,'cancelled');}
  await models.UsuarioClinica.destroy({where:{id_usuario:99,id_clinica:72}});await assert.rejects(service.begin(inputs[1]),{code:'meta_oauth_scope_forbidden'});
  await models.UsuarioClinica.create({id_usuario:99,id_clinica:72,rol_clinica:'agencia',estado_invitacion:'aceptada'});
  report.checks.push('Verified non-global client owner/agency requires membership in both Beta clinics; cancelled authorization, reused USER identity and insufficient Business permissions preserve original working grants');
  const newIds=[];
  for(let index=0;index<2;index++){
    const start=await begin(inputs[index]);await callback(start);let overview=await service.overview(inputs[index]);assert.equal(overview.pending.canConfirm,true);assert.equal(overview.pending.assetCount,index===0?2:4);
    await assert.rejects(service.confirm(inputs[index],start.requestId,confirmationFrom(overview.pending,{subjectId:'999'})),{code:'meta_business_identity_mismatch'});
    loseBusinessAck=index===1;
    if(index===0)models.PlatformAuditEvent.addHook('beforeCreate','business-handover-sql-ack',event=>{if(JSON.parse(event.body).reason==='meta_business_activated')throw Error('FICTITIOUS_BUSINESS_AUDIT_FAILURE');});
    try{await service.confirm(index===0?refreshed:inputs[index],start.requestId,confirmationFrom(overview.pending));}
    finally{if(index===0)models.PlatformAuditEvent.removeHook('beforeCreate','business-handover-sql-ack');}
    if(index===0){assert.equal((await loadH(start.requestId)).state,'activate_pending');assert.equal((await models.MetaMarketingEnrollmentRequest.findByPk(initial[index].enrollment_id)).state,'active');assert.equal(await models.MetaMarketingEnrollmentRequest.count({where:{enrollment_id:start.requestId}}),0);await service.reconcile(inputs[index],start.requestId);}
    if(index===1){assert.equal((await loadH(start.requestId)).state,'activate_pending');await service.reconcile(inputs[index],start.requestId);}
    const saved=await loadH(start.requestId);assert.equal(saved.state,'active');assert.equal((await models.MetaMarketingEnrollmentRequest.findByPk(initial[index].enrollment_id)).state,'superseded');
    const row=await models.MetaMarketingEnrollmentRequest.findByPk(start.requestId,{raw:true});assert.notEqual(row.meta_connection_id,159);assert.equal(row.mapping_ids,initial[index].mapping_ids);assert.equal(row.assets,initial[index].assets);newIds.push(start.requestId);
    assert.equal(calls.filter(call=>call.business&&call.name==='activate'&&call.id===start.requestId).length,1);
    assert((await sql.transaction(transaction=>require('../../../services/metaMarketingEnrollmentBinding.service').createBindings({models,now}).committed(start.requestId,transaction))).business);
    if(index===0){await sql.transaction(transaction=>require('../../../services/metaMarketingEnrollmentBinding.service').createBindings({models,now}).committed(initial[1].enrollment_id,transaction));assert.equal((await credentials.getCredentialStatus(await models.MetaMarketingEnrollmentRequest.findByPk(initial[1].enrollment_id,{raw:true}))).tokenType,'USER');}
    const current=await credentials.getCredentialStatus(row);assert.equal(current.tokenType,'SYSTEM_USER');assert.equal(current.epoch,0);assert.equal(current.issuerKind,agencyMode&&index===1?C.A.ISSUER:'BISU');
    if(agencyMode&&index===1){assert.equal(current.clientBusinessId,null);assert.equal(current.issuerBusinessId,'348');assert.equal((await service.overview(inputs[index])).current.maintenance.mechanism,'agency_system_user');}
    const dataAccess=await require('../../../services/metaConnectionMetadata.service').createMetaDataAccessRepository(models,{now,enabled:()=>true})({scopeKey:row.scope_key,clinicIds:E.clinics(row.clinic_ids)});
    assert.equal(dataAccess.value.scope.clinicCount,2);assert.equal(dataAccess.value.sources[0],'meta_ads');await dataAccess.assert();
    assert.deepEqual(require('../../../lib/metaMarketingCredentialAlerts').alertsFromStatus(current,+now(),await require('../../../services/metaMarketingCredentialMaintenance.service').createMaintenance({models,now}).getMaintenanceStatus(row)),[]);
    const old=previousStatus.get(initial[index].enrollment_id),identity={enrollmentId:old.enrollmentId,connectionId:old.connectionId,epoch:old.epoch,versionId:old.versionId,scopeKey:old.scopeKey};
    const source=require('../../../services/metaMarketingBusinessSource.service').createSource({models,now}),confirmed=await source.getConfirmedHandover(identity);assert(confirmed);assert.equal(confirmed.currentStatus.enrollmentId,start.requestId);
    assert.equal(await source.getConfirmedHandover({...identity,versionId:randomUUID()}),null);
    assert(require('../../../lib/metaMarketingCredentialAlerts').handoverResolution(previousAlerts.get(old.enrollmentId),confirmed,+now()));
  }
  assert.deepEqual((await models.MetaMarketingEnrollmentRequest.findAll({where:{enrollment_id:{[Op.in]:initial.map(row=>row.enrollment_id)}},raw:true,order:[['scope_key','ASC']]})).map(C.freeze),original);
  assert.equal(JSON.stringify(await models.MetaMarketingRecovery.findAll({raw:true,order:[['recovery_id','ASC']]})),recoveries);assert.equal(await baseline(),untouched);
  report.checks.push('Two new Business identities/canonical connections transfer the exact original claims and 2/4 asset mapping IDs atomically; SQL audit rollback and owner ACK loss both reconcile one owner CAS, old enrollments become superseded without revocation and immutable Recovery/WhatsApp history remains unchanged');
  const maintenance=require('../../../services/metaMarketingCredentialMaintenance.service').createMaintenance({models,client,now,enabled:()=>true});
  const drainAudit=async()=>{const repo=require('../../../services/platformAudit.repository'),event=require('../../../../services/platform-audit/src/event');const result=await repo.drain(repo.createRepository(models.PlatformAuditEvent),{write:async row=>({key:event.keyFor(row),digest:row.digest,versionId:'FICTITIOUS_BUSINESS_AUDIT_ACK'})},{now,limit:100});assert.equal(result.failed,0);};
  await drainAudit();advance(46*86400000+1);temporaryMaintenance=true;
  let result=await maintenance.run();assert.equal(result.failed,1);const retry=await models.MetaMarketingCredentialMaintenance.findOne({where:{state:'retry_wait'},raw:true});assert(retry);assert.equal(+retry.next_attempt_at-+now(),7200000);
  assert.equal((await credentials.getCredentialStatus(await models.MetaMarketingEnrollmentRequest.findByPk(retry.enrollment_id,{raw:true}))).epoch,0);
  await drainAudit();advance(7200001);loseMaintenanceAck=true;await maintenance.run();
  const uncertain=await models.MetaMarketingCredentialMaintenance.findOne({where:{state:'retry_wait'},raw:true});assert(uncertain);await maintenance.reconcile(uncertain.maintenance_id);
  for(const id of newIds){const row=await models.MetaMarketingEnrollmentRequest.findByPk(id,{raw:true}),status=await credentials.getCredentialStatus(row);assert.equal(status.epoch,1);assert.equal(status.healthKind,'healthy');assert.equal(status.tokenType,'SYSTEM_USER');assert(status.expiresAt>+now()+59*86400000);await sql.transaction(transaction=>require('../../../services/metaMarketingEnrollmentBinding.service').createBindings({models,now}).committed(id,transaction));
    const control=await maintenance.getMaintenanceStatus(row);assert.equal(control.automaticSupported,true);assert.deepEqual(require('../../../lib/metaMarketingCredentialAlerts').alertsFromStatus(status,+now(),control),[]);
  }
  assert.equal(await baseline(),untouched);assert.equal(await models.MetaMarketingEnrollmentClaim.count(),6);
  report.checks.push('Actual SQL maintenance starts at the earliest real expiry minus14days, honors provider RetryAfter, preserves old versions on temporary failure, reconciles lost owner ACK without minting twice, advances each Business epoch and schedules its next finite expiry; successful real helper DTOs produce no alerts');
  const policy=require('../../../lib/metaMarketingCredentialAlerts');
  await drainAudit();advance(21600001);healthPlan='temporary';await maintenance.run();
  let currentRow=await models.MetaMarketingEnrollmentRequest.findByPk(newIds[0],{raw:true}),status=await credentials.getCredentialStatus(currentRow),control=await maintenance.getMaintenanceStatus(currentRow);assert(control.unknownSince!==null);assert.deepEqual(policy.alertsFromStatus(status,+now(),control),[]);
  const firstUnknown=control.unknownSince;advance(21600001);await maintenance.run();control=await maintenance.getMaintenanceStatus(currentRow);assert.equal(control.unknownSince,firstUnknown);assert(policy.alertsFromStatus(await credentials.getCredentialStatus(currentRow),+now(),control).some(value=>value.metadata.credential.kind==='supervision_unknown'));
  advance(1800001);healthPlan='healthy';await maintenance.run();control=await maintenance.getMaintenanceStatus(currentRow);assert.equal(control.unknownSince,null);assert.deepEqual(policy.alertsFromStatus(await credentials.getCredentialStatus(currentRow),+now(),control),[]);assert.equal((await credentials.getCredentialStatus(currentRow)).epoch,1);
  report.checks.push('Real version-pinned health observations run outside the14day renewal window; transient supervision failure keeps the grant, preserves first unknown time, alerts only after6hours and resolves on positive provider observation of the same version without rotating');
  advance(21600001);healthPlan='permission_lost';healthTarget=newIds[0];await maintenance.run();status=await credentials.getCredentialStatus(currentRow);assert.equal(status.healthKind,'permission_lost');assert.equal((await models.MetaMarketingEnrollmentRequest.findByPk(newIds[0])).state,'active');assert(policy.alertsFromStatus(status,+now(),await maintenance.getMaintenanceStatus(currentRow)).length>0);
  const freshInput=actor(28),reconsent=await begin(freshInput);await callback(reconsent);let overview=await service.overview(freshInput);assert.equal(overview.pending.canConfirm,true);
  const oldCanonical=currentRow.meta_connection_id;await service.confirm(freshInput,reconsent.requestId,confirmationFrom(overview.pending));
  assert.equal((await loadH(reconsent.requestId)).state,'active');currentRow=await models.MetaMarketingEnrollmentRequest.findByPk(reconsent.requestId,{raw:true});assert.equal(currentRow.meta_connection_id,oldCanonical);assert.equal((await credentials.getCredentialStatus(currentRow)).healthKind,'healthy');assert.equal(currentRow.mapping_ids,initial[0].mapping_ids);
  const previous=previousStatus.get(initial[0].enrollment_id),lineage=await require('../../../services/metaMarketingBusinessSource.service').createSource({models,now}).getConfirmedHandover({enrollmentId:previous.enrollmentId,connectionId:previous.connectionId,epoch:previous.epoch,versionId:previous.versionId,scopeKey:previous.scopeKey});
  assert.equal(lineage.currentStatus.enrollmentId,reconsent.requestId);assert(policy.handoverResolution(previousAlerts.get(previous.enrollmentId),lineage,+now()));
  report.checks.push('Metadata-only confirmed handover lineage resolves the exact prior credential incident across a second authorization without scope-only matching, provider calls, duplicate mail or historical lead replay; a wrong prior version is rejected');
  await drainAudit();advance(46*86400000+1);healthPlan='healthy';
  const otherWorker=require('../../../services/metaMarketingCredentialMaintenance.service').createMaintenance({models,client,now,enabled:()=>true});
  await Promise.all([maintenance.run(),otherWorker.run()]);
  const concurrent=await models.MetaMarketingCredentialMaintenance.findOne({where:{enrollment_id:newIds[1],expected_epoch:1,state:'succeeded'},raw:true});assert(concurrent);
  assert.equal(calls.filter(value=>!value.business&&value.name==='rotate'&&value.id===concurrent.maintenance_id).length,1);
  const beforeFailures=(await credentials.getCredentialStatus(await models.MetaMarketingEnrollmentRequest.findByPk(newIds[1],{raw:true}))).versionId;
  await drainAudit();advance(46*86400000+1);alwaysTemporaryMaintenanceId=newIds[1];
  for(const hours of[0,1,2,4,8]){if(hours){await drainAudit();advance(hours*3600000+1);}await maintenance.run();}
  const capped=await models.MetaMarketingCredentialMaintenance.findOne({where:{enrollment_id:newIds[1],expected_epoch:2,state:'retry_wait'},raw:true});assert(capped);assert.equal(capped.attempts,5);
  const retries=calls.filter(value=>!value.business&&value.name==='rotate'&&value.id===capped.maintenance_id);assert.equal(retries.length,5);assert.equal(new Set(retries.map(value=>value.requestId)).size,1);
  const nextAttempt=+capped.next_attempt_at;await maintenance.reconcile(capped.maintenance_id);assert.equal((await models.MetaMarketingCredentialMaintenance.findByPk(capped.maintenance_id)).attempts,5);assert.equal(+(await models.MetaMarketingCredentialMaintenance.findByPk(capped.maintenance_id)).next_attempt_at,nextAttempt);
  const healthyOld=await credentials.getCredentialStatus(await models.MetaMarketingEnrollmentRequest.findByPk(newIds[1],{raw:true}));assert.equal(healthyOld.versionId,beforeFailures);assert.deepEqual(policy.alertsFromStatus(healthyOld,+now(),await maintenance.getMaintenanceStatus(await models.MetaMarketingEnrollmentRequest.findByPk(newIds[1],{raw:true}))),[]);
  report.checks.push('Two concurrent SQL workers claim one provider operation per enrollment/version; repeated temporary renewal failure reuses one command, observes1/2/4/8/24hour backoff and stops at5 attempts per24hours, retaining a healthy usable old credential without premature alerts');
  await sql.transaction(async transaction=>{
    await require('../../../services/metaMarketingLegacyRecovery.service').createRecovery({models,now,enabled:()=>true}).retireForScope({scope:{assignmentScope:'group',groupId:28},clinicIds:[1,70]},transaction);
    await require('../../../services/metaMarketingBusinessSource.service').createSource({models,now}).retireForScope({scope:{assignmentScope:'group',groupId:28},clinicIds:[1,70]},transaction);
  });
  assert.equal((await service.overview(actor(28))).canBegin,false);await assert.rejects(service.begin(actor(28)),{code:'meta_business_scope_forbidden'});
  assert.equal(await require('../../../services/metaConnectionMetadata.service').createMetaDataAccessRepository(models,{now,enabled:()=>true})({scopeKey:'group:28',clinicIds:[1,70]}),null);
  assert.equal((await models.MetaMarketingEnrollmentRequest.findByPk(newIds[1])).state,'active');await sql.transaction(transaction=>require('../../../services/metaMarketingEnrollmentBinding.service').createBindings({models,now}).committed(newIds[1],transaction));assert.equal(await baseline(),untouched);
  report.checks.push('Confirmed permission loss preserves authorization history and supports fresh verified client reconsent into the same Business canonical identity without Root preparation; explicit scope withdrawal stays irreversible and cannot revive assets or affect the other Beta group/WhatsApp');
  report.business={scopes:2,confirmedHandovers:3,bsIssuer:agencyMode?C.A.ISSUER:'BISU',bsAssets:4,oldState:'superseded',waUnchanged:true,providerRequests:0,liveSql:false};report.pool={inUse:sql.connectionManager.pool.using,waiting:sql.connectionManager.pool.waiting};assert.deepEqual(report.pool,{inUse:0,waiting:0});
};
