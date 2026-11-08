'use strict';
// Extends the existing owned, skip-networking V2 fixture. Every provider value
// and receipt is fictitious; the actual scope, authority, writer and reader run.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
module.exports=async({models,sql,now,report,sessions,guard})=>{
  const C=require('../../../services/metaMarketingEnrollment.contract'),G=require('../../../services/metaMarketingLegacyRecovery.service');
  const D=require('../../../../services/integrations-broker/src/meta-marketing-discovery-contract');
  const scope=require('../../../services/metaMarketingOAuthScope.service').createScope({models,sessions,now,recoveryGuard:guard});
  const old=async()=>G.encode({connections:await models.MetaConnection.findAll({raw:true,order:[['id','ASC']]}),
    grants:await models.MetaConnectionAssignment.findAll({where:{scopeKey:{[require('sequelize').Op.ne]:'clinic:95'}},raw:true,order:[['id','ASC']]}),
    mappings:await models.ClinicMetaAsset.findAll({where:{clinicaId:{[require('sequelize').Op.or]:{[require('sequelize').Op.ne]:95,[require('sequelize').Op.is]:null}}},raw:true,order:[['id','ASC']]}),
    recoveries:await models.MetaMarketingRecovery.findAll({raw:true,order:[['recovery_id','ASC']]})});
  const preserved=await old();
  await models.Clinica.create({id_clinica:95,nombre_clinica:'Fictitious new clinic',grupoClinicaId:null,estado_clinica:true});
  const actor={scopeKey:'clinic:95',actorId:1,sessionRef:randomUUID(),sessionExpiresAt:new Date(+now()+7200000)},flowId=randomUUID();
  const scopes=['ads_read','pages_manage_metadata','pages_read_engagement','pages_show_list','public_profile'];
  const slot={scope_key:actor.scopeKey,connection_ref:'connection:fixture-95',asset_ref:'meta-enroll:clinic:95',app_id:'101',clinic_ids:'[95]',scopes:JSON.stringify(scopes),
    redirect_uri:'https://app.example.invalid/oauth/meta/marketing/callback',expires_at:new Date(+now()+86400000),state:'active'};
  await models.MetaMarketingOAuthSlot.create(slot);const captured=await sql.transaction(t=>scope.capture(actor,t));
  const candidate={versionId:flowId,digest:C.hash('FICTITIOUS_NEW_SCOPE_CANDIDATE'),appId:'101',subjectId:'201',tokenType:'USER',scopes,
    expiresAt:+now()+7200000,dataAccessExpiresAt:null,granularScopes:[]};
  const flow=await models.MetaMarketingOAuthRequest.create({flow_id:flowId,state_hash:C.hash(flowId),...slot,slot_digest:captured.slotDigest,scope_digest:captured.scopeDigest,
    actor_user_id:actor.actorId,session_ref:actor.sessionRef,session_expires_at:actor.sessionExpiresAt,return_origin:'https://app.example.invalid',
    requested_at:now(),expires_at:new Date(+now()+600000),state:'staged',candidate_metadata:JSON.stringify(candidate),next_attempt_at:now(),completed_at:now()});
  const assets=[{kind:'ad_account',id:'601',assetRef:'meta-ad_account:601',name:'Fictitious new account',accountStatus:1,currency:'EUR',timezone:'Europe/Madrid',parentPageId:null},
    {kind:'facebook_page',id:'701',assetRef:'meta-facebook_page:701',name:'Fictitious new page',parentPageId:null}];
  const inventory={flowId,candidateVersionId:flowId,candidateDigest:candidate.digest,scopeDigest:flow.scope_digest,scopeKey:actor.scopeKey,clinicSetDigest:C.hash('[95]'),
    observedAt:+now(),expiresAt:+now()+300000,accessBlocked:true,availableKinds:D.kinds(candidate),assets};
  const oauth={assets:async()=>({inventory})},authority=require('../../../services/metaMarketingEnrollmentAuthority.service').createAuthority({models,sessions,oauth,now,enabled:()=>true,recoveryGuard:guard});
  const bindings=require('../../../services/metaMarketingEnrollmentBinding.service').createBindings({models,sessions,authority,now,recoveryGuard:guard});
  const review=require('../../../services/metaMarketingEnrollmentReview.service').createReview({models,sessions,now,recoveryGuard:guard});
  const observation=await sql.transaction(t=>review({row:flow.get({plain:true}),inventory},t));assert.equal(observation.scopeStatus,'clear');
  assert(observation.assets.every(asset=>asset.status==='clear'));assert.equal(await old(),preserved);
  const selected=assets.map(asset=>asset.assetRef),pending=await authority.reserve(actor,flowId,selected);assert.equal(pending.meta_connection_id,159);
  assert.equal(await models.MetaConnection.count(),2);assert.equal(await models.MetaMarketingEnrollmentIdentity.count(),1);assert.equal(await old(),preserved);
  await models.MetaMarketingEnrollmentRequest.update({state:'activate_pending',selection_digest:C.hash('FICTITIOUS_NEW_SELECTION'),prepared_at:now(),
    lease_token:randomUUID(),lease_until:new Date(+now()+120000)},{where:{enrollment_id:pending.enrollment_id}});
  const row=C.request(await models.MetaMarketingEnrollmentRequest.findByPk(pending.enrollment_id,{raw:true}));
  const receipt={enrollmentId:row.enrollment_id,flowId,scopeKey:row.scope_key,scopeDigest:row.scope_digest,candidateDigest:row.candidate_digest,
    selectionDigest:row.selection_digest,clinicSetDigest:C.hash(row.clinic_ids),assets:row.selected,status:'active',accessBlocked:false,preparedAt:+now(),activatedAt:+now()};
  // The unchanged generic-grant writer still blocks cross-WhatsApp authority.
  const wa=await models.ClinicMetaAsset.create({metaConnectionId:159,assignmentScope:'clinic',clinicaId:95,assetType:'whatsapp_phone_number',metaAssetId:'9991',isActive:true});
  try{await assert.rejects(sql.transaction(t=>bindings.activate(row,receipt,t)),{code:'meta_enrollment_assignment_review'});}finally{await wa.destroy();}
  assert.equal(await models.MetaConnectionAssignment.count({where:{scopeKey:'clinic:95'}}),0);
  await sql.transaction(t=>bindings.activate(row,receipt,t));
  const committed=()=>sql.transaction(t=>bindings.committed(row.enrollment_id,t));
  const active=await committed();assert.equal(active.recovery,null);assert.equal(active.business,null);assert.equal(active.mappingIds.length,2);
  const grant=await models.MetaConnectionAssignment.findOne({where:{scopeKey:'clinic:95'},raw:true});assert.equal(grant.metaConnectionId,159);
  assert.equal(grant.assignmentScope,'clinic');assert.equal(grant.clinicaId,95);assert.equal(grant.grupoClinicaId,null);
  const repository=require('../../../services/metaMarketingBrokerScope.service').createMetaMarketingScopeRepository(()=>models);
  const broker=require('../../../services/metaMarketingBrokerScope.service').createMetaMarketingBrokerScope({...repository,enabled:()=>true});
  const context=await broker.prepare(active.mappingIds[0]);assert.equal(broker.describe(context).enrollmentId,row.enrollment_id);await broker.assertContext(context);
  // Schedule the old recovered reader while it holds shared connection rows
  // immediately before Identity. The new ordinary resolver must wait on those
  // connections without holding Identity, otherwise the two transactions cycle.
  const originActive=await models.MetaMarketingRecovery.findOne({where:{state:'active'},raw:true});assert(originActive);
  const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
  const ownerReached=deferred(),newConnectionsReached=deferred(),releaseOld=deferred();
  const oldTx=await sql.transaction({isolationLevel:'REPEATABLE READ'});let newTx,oldWork,newWork;
  models.MetaMarketingEnrollmentIdentity.addHook('beforeFind','identity-order-old',async options=>{
    if(options.transaction===oldTx){ownerReached.resolve();await releaseOld.promise;}
  });
  models.MetaConnection.addHook('beforeFind','identity-order-new',options=>{if(options.transaction===newTx)newConnectionsReached.resolve();});
  try{
    oldWork=bindings.committed(originActive.enrollment_id,oldTx);await ownerReached.promise;
    newTx=await sql.transaction({isolationLevel:'REPEATABLE READ'});
    newWork=require('../../../services/metaMarketingCanonicalIdentity.service').resolveUserIdentity({models,appId:'101',subjectId:'201',
      expectedConnectionId:159,transaction:newTx,lock:true,requireRegistered:true,allowHistoricalReuse:true});
    await newConnectionsReached.promise;releaseOld.resolve();
    await oldWork;await oldTx.commit();assert.equal((await newWork).connection.id,159);await newTx.commit();
  }finally{
    releaseOld.resolve();models.MetaMarketingEnrollmentIdentity.removeHook('beforeFind','identity-order-old');
    models.MetaConnection.removeHook('beforeFind','identity-order-new');
    await Promise.allSettled([oldWork,newWork].filter(Boolean));
    if(!oldTx.finished)await oldTx.rollback();if(newTx&&!newTx.finished)await newTx.rollback();
  }
  report.checks.push('Deterministic concurrent real recovered committed reader plus ordinary identity writer share connections before Identity, complete without deadlock and take no foreign history locks');
  // Real retired+revoked origin survives flow cancellation without coupling the
  // new scope to foreign credential expiry or lifecycle state.
  const retired=await models.MetaMarketingRecovery.findOne({where:{state:'retired'},raw:true});assert(retired);
  const historicalFlow=await models.MetaMarketingOAuthRequest.findByPk(retired.flow_id,{raw:true});
  for(const state of ['cancel_pending','cancelled']){
    await models.MetaMarketingOAuthRequest.update({state,completed_at:new Date(+now()+12345)},{where:{flow_id:retired.flow_id}});
    assert.equal((await committed()).digest,active.digest);await broker.assertContext(context);
  }
  await models.MetaMarketingOAuthRequest.update({state:historicalFlow.state,completed_at:historicalFlow.completed_at},{where:{flow_id:retired.flow_id}});
  // History storage uncertainty must remain retryable, never an identity-based
  // closing error which would withdraw the healthy new grant.
  const before=await models.MetaMarketingEnrollmentRequest.findByPk(row.enrollment_id,{raw:true});
  models.MetaMarketingRecovery.addHook('beforeFind','identity-history-unavailable',options=>{if(!options.lock)throw Object.assign(Error('FICTITIOUS_HISTORY_UNAVAILABLE'),{code:'ETIMEDOUT'});});
  try{
    await assert.rejects(committed(),{code:'ETIMEDOUT'});
    const worker=require('../../../services/metaMarketingEnrollment.service').createService({models,sessions,oauth,now,enabled:()=>true,workerEnabled:()=>true,
      client:{execute:async()=>assert.fail('Storage failure must precede broker control I/O')}});
    await models.MetaMarketingEnrollmentRequest.update({next_attempt_at:now()},{where:{enrollment_id:row.enrollment_id}});
    assert.equal((await worker.run({enrollmentId:row.enrollment_id})).failed,1);
  }finally{models.MetaMarketingRecovery.removeHook('beforeFind','identity-history-unavailable');}
  const after=await models.MetaMarketingEnrollmentRequest.findByPk(row.enrollment_id,{raw:true});assert.equal(after.state,'active');assert.equal(after.revoked_at,null);
  assert.equal(after.mapping_ids,before.mapping_ids);assert.equal(after.selection_digest,before.selection_digest);await committed();
  // Foreign scope tombstones and grant conflicts retain their ordinary force.
  const block=await models.MetaScopeBlock.create({scope_key:'meta:clinic:95',reason:'scope_disconnected',connection_id:159,actor_user_id:1,created_at:now()});
  try{await assert.rejects(committed(),{code:'meta_oauth_scope_blocked'});}finally{await block.destroy();}
  await models.MetaConnectionAssignment.update({status:'disconnected'},{where:{id:grant.id}});
  try{await assert.rejects(committed(),{code:'meta_enrollment_assignment_review'});}finally{await models.MetaConnectionAssignment.update({status:'active'},{where:{id:grant.id}});}
  const third=await models.MetaConnection.create({id:160,userId:null,metaUserId:'201',credentials_external:true,broker_app_id:'101',accessToken:null});
  try{await assert.rejects(committed(),{code:'meta_enrollment_identity_review'});}finally{await third.destroy();}
  await committed();assert.equal(await old(),preserved);
  report.checks.push('Ordinary new clinic95 reuses only registered canonical159 through actual read-only review, fresh USER reserve, writer, committed and standalone broker repository; old two recovery generations/source/grants/WA unchanged; own fresh credentials and scope retained');
  report.checks.push('New95 keeps ordinary generic-grant WA exclusion, own tombstone/grant checks and third-subject denial; historical retired/revoked/cancelled lineage remains identity-only and digest-stable; storage timeout retries without withdrawal or provider I/O');
};
