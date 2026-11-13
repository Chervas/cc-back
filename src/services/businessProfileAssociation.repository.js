'use strict';
const {randomUUID} = require('node:crypto'); const {Op} = require('sequelize');
const C = require('./businessProfileAssociation.contract'); const O = require('./googleOAuthCohort.contract');
const {fromAssociation} = require('../../services/platform-audit/src/business-profile-association-event');
const {createRepository} = require('./platformAudit.repository');
const Generations = require('./businessProfileBindingGeneration.service');
const Reassociation = require('./businessProfileReassociation.service');
const plain = row => row?.get ? row.get({plain:true}) : row;
const mapFields = ['id','clinica_id','google_connection_id','location_id','location_name','store_code','is_active','broker_read_connection_ref','broker_read_asset_ref','raw_payload'];
function createRepositoryForAssociation({models,sessions,audit,authorize,now=()=>new Date(),enabled=()=>process.env.GOOGLE_BUSINESS_PROFILE_ASSOCIATION_ENABLED === 'true'}) {
  const m = () => typeof models === 'function' ? models() : models;
  const opts = transaction => ({transaction,lock:transaction.LOCK.UPDATE,logging:false});
  const trans = fn => m().sequelize.transaction(fn);
  const bounded = rows => {if (!Array.isArray(rows) || rows.length > 1000) C.fail('gbp_association_limit'); return rows;};
  async function sourceFingerprint(source,impact,auth,input,transaction,excludeId){
    const lineage=(await Reassociation.lineageSnapshot({models:m(),scope:auth.scope,clinic:auth.clinic,actorId:input.actorId,transaction})).filter(v=>Number(v.mapping[0])!==Number(excludeId));
    return C.associationFingerprint(source,impact.reviewCampaignImpactDigest,lineage);
  }
  async function record(row,reason,transaction,actor={}) {
    const events = audit || createRepository(m().PlatformAuditEvent); const date=now(); const health=await events.health(date,{includeUnresolved:false,transaction});
    if (!Number.isSafeInteger(health.pending) || health.pending >= 9999 || !Number.isFinite(health.oldestAgeSeconds) || health.oldestAgeSeconds >= 3600) C.fail('audit_unavailable');
    await events.append(fromAssociation(plain(row),reason,date,actor),{transaction});
  }
  function actor(input) {
    if (!input || !C.positive(input.clinicId) || input.scopeKey !== 'clinic:' + Number(input.clinicId) || !C.positive(input.actorId) || !C.UUID.test(input.sessionRef) || !Number.isSafeInteger(input.sessionExpiresAt) || input.sessionExpiresAt <= now().getTime() || !C.positive(input.connectionId)) C.fail('gbp_association_session_required');
  }
  async function authority(input,transaction,{cleanup=false}={}) {
    actor(input); if (!enabled()&&!cleanup) C.fail('gbp_association_disabled'); const db=m(), q=opts(transaction);
    const scope=plain(await db.BusinessProfileAssociationScope.findByPk(input.scopeKey,{...q,raw:true}));
    if (!scope || !['active','blocked'].includes(scope.state) || scope.state !== 'active'&&!cleanup) C.fail('gbp_association_scope_unconfigured');
    scope.account_ids=C.array(scope.account_ids); scope.location_ids=C.array(scope.location_ids);
    if (scope.scope_key !== input.scopeKey || Number(scope.clinica_id) !== Number(input.clinicId) || Number(scope.google_connection_id) !== Number(input.connectionId)
      || !C.ref(scope.connection_ref) || scope.scope_ref !== 'gbp-enroll:' + input.scopeKey || !scope.account_ids.length || scope.account_ids.length > 10 || scope.account_ids.some(v=>!C.external(v)) || new Set(scope.account_ids).size !== scope.account_ids.length || !scope.location_ids.length || scope.location_ids.length > 1000 || scope.location_ids.some(v=>!C.external(v)) || new Set(scope.location_ids).size !== scope.location_ids.length) C.fail('gbp_association_scope_conflict');
    const clinic=plain(await db.Clinica.findByPk(Number(input.clinicId),{...q,attributes:['id_clinica','grupoClinicaId','nombre_clinica'],raw:true}));
    if (!clinic || Number(clinic.id_clinica) !== Number(input.clinicId)) C.fail('scope_denied');
    const oauth=plain(await db.GoogleOAuthBrokerBinding.findOne({...q,raw:true,where:{google_connection_id:Number(input.connectionId),cohort:'business_profile'}}));
    if (!oauth || O.cohortOf(O.validate(oauth)) !== 'business_profile' || oauth.google_user_id !== scope.google_user_id || oauth.connection_ref !== scope.connection_ref || !oauth.confirmed_at) C.fail('gbp_association_identity_mismatch');
    const args={models:db,connectionId:Number(input.connectionId),subject:scope.google_user_id,requestScopeKey:input.scopeKey,actorId:Number(input.actorId),sessionRef:input.sessionRef,expiresAt:new Date(input.sessionExpiresAt),transaction,sessions:sessions || require('./accessSession.service')};
    try {
      if (authorize) {if (await authorize(args) !== true) C.fail('scope_denied');}
      else await require('./googleOAuthCohortScope.service').authorizeConnection(args);
    } catch(error) {
      if(error?.code==='google_oauth_scope_forbidden'||error?.code==='scope_denied')C.fail('scope_denied');
      if(error?.status===401||error?.httpStatus===401||error?.code==='auth_invalid'||['JsonWebTokenError','TokenExpiredError','NotBeforeError'].includes(error?.name))C.fail('gbp_association_session_required');
      if(error?.code==='google_oauth_scope_conflict')C.fail('gbp_association_scope_conflict');
      throw error;
    }
    const scopes=[input.scopeKey,...(C.positive(clinic.grupoClinicaId) ? ['group:' + clinic.grupoClinicaId] : [])];
    const assignments=bounded(await db.GoogleConnectionAssignment.findAll({...q,raw:true,attributes:['id','scopeKey','assignmentScope','clinicaId','grupoClinicaId','googleConnectionId','status'],where:{scopeKey:{[Op.in]:scopes}},order:[['id','ASC']],limit:1001}));
    const direct=assignments.filter(row=>row.scopeKey === input.scopeKey); const inherited=assignments.filter(row=>row.scopeKey === scopes[1]); const selected=direct.length ? direct : inherited;
    if (selected.length !== 1 || selected[0].status !== 'active' || Number(selected[0].googleConnectionId) !== Number(input.connectionId)) C.fail('gbp_association_scope_conflict');
    const group=clinic.grupoClinicaId == null ? null : plain(await db.GrupoClinica.findByPk(Number(clinic.grupoClinicaId),{...q,attributes:['id_grupo','business_profile_assignment_mode','business_profile_primary_location_id'],raw:true}));
    const assetAssignments=bounded(await db.GroupAssetClinicAssignment.findAll({...q,attributes:['assetId','clinicaId','grupoClinicaId'],raw:true,where:{assetType:'google.business_profile',clinicaId:Number(input.clinicId)},limit:1001}));
    const effectiveAssetBlocked=group?.business_profile_assignment_mode === 'group' || assetAssignments.length > 0;
    const digest=C.hash({scope,clinic:[Number(clinic.id_clinica),clinic.grupoClinicaId ?? null],assignments,group,assetAssignments,oauth:O.digest(oauth)});
    return {scope,clinic,oauth,authorityDigest:digest,oauthDigest:O.digest(oauth),effectiveAssetBlocked};
  }
  async function current(input,transaction) {
    const rows=bounded(await m().ClinicBusinessLocation.findAll({...opts(transaction),attributes:mapFields,raw:true,where:{clinica_id:Number(input.clinicId),is_active:true},order:[['id','ASC']],limit:1001}));
    if (rows.length > 1) C.fail('gbp_association_current_ambiguous');
    const row=rows[0] || null;
    if (row && Number(row.google_connection_id) !== Number(input.connectionId)) C.fail('gbp_association_scope_conflict');
    if (row) {
      const binding=await Generations.resolveMappingBinding({models:m(),mapping:row,transaction});
      if (!binding || binding.state !== 'active' || Number(binding.clinica_id) !== Number(row.clinica_id) || Number(binding.google_connection_id) !== Number(row.google_connection_id) || binding.connection_ref !== row.broker_read_connection_ref || binding.asset_ref !== row.broker_read_asset_ref) C.fail('broker_binding_invalid');
      if (await m().BusinessProfileBrokerRevocation.findByPk(C.location(row.location_id),{...opts(transaction),attributes:['external_location_id'],raw:true})) C.fail('asset_revoked');
    }
    return row;
  }
  async function dependencies(source,auth,transaction,{allowReviewChange=false}={}) {
    const db=m(),q=opts(transaction),clinicId=Number(auth.clinic.id_clinica);
    if(source) {
      if(source.broker_read_asset_ref===auth.oauth.asset_ref&&Number(source.clinica_id)===Number(auth.oauth.clinica_id))C.fail('gbp_association_oauth_anchor');
      const shares=await db.GroupAssetClinicAssignment.findAll({...q,attributes:['assetId','clinicaId'],raw:true,where:{assetType:'google.business_profile',assetId:Number(source.id)},limit:1});
      const groups=await db.GrupoClinica.findAll({...q,attributes:['id_grupo'],raw:true,where:{business_profile_primary_location_id:Number(source.id)},limit:1});
      if(shares.length||groups.length)C.fail('gbp_association_shared_dependency');
      // The ordinary alias writer locks this same source mapping first.
      const clinics=bounded(await db.Clinica.findAll({transaction,logging:false,attributes:['id_clinica','configuracion'],raw:true,limit:1001}));
      if(clinics.some(row=>C.reviewReference(row.configuracion,source)))C.fail('gbp_association_review_dependency');
      if(await db.BusinessProfileMutation.findOne({...q,attributes:['operation_id'],raw:true,where:{mapping_id:Number(source.id),state:'attempted'}}))C.fail('gbp_association_mutation_pending');
    }
    // Review dispatches resolve their URL dynamically. Changing that target is
    // an explicit extra user decision, recorded in this same durable intent.
    const lists=bounded(await db.MarketingPatientList.findAll({...q,attributes:['id','clinica_id','objective_id','source','status','criteria','clinic_ids'],raw:true,
      where:{[Op.or]:[{clinica_id:clinicId},{grupo_clinica_id:auth.clinic.grupoClinicaId||-1}]},limit:1001}));
    const applies=row=>Number(row.clinica_id)===clinicId||row.clinic_ids==null||!C.array(row.clinic_ids).length||C.array(row.clinic_ids).some(id=>Number(id)===clinicId);
    const impacted=lists.filter(row=>applies(row)&&C.reviewCampaign(row)&&!['archived','cancelled'].includes(row.status)).sort((a,b)=>Number(a.id)-Number(b.id));
    const impact={reviewDestinationChangeRequired:impacted.length>0,affectedReviewCampaignCount:impacted.length,
      reviewCampaignImpactDigest:C.hash(impacted.map(row=>[Number(row.id),row.clinica_id==null?null:Number(row.clinica_id),row.clinic_ids==null?null:C.array(row.clinic_ids).map(Number).sort((a,b)=>a-b)]))};
    if(impact.reviewDestinationChangeRequired&&!allowReviewChange)C.fail('gbp_association_campaign_dependency');
    return impact;
  }
  async function snapshot(input,{expectedFingerprint,expectedAuthority,checkDependencies=true,allowReviewChange=false}={}) {
    return trans(async transaction=>{
      const auth=await authority(input,transaction); const source=await current(input,transaction);
      if(expectedAuthority&&auth.authorityDigest!==expectedAuthority)C.fail('gbp_association_scope_changed');
      let impact={reviewDestinationChangeRequired:false,affectedReviewCampaignCount:0,reviewCampaignImpactDigest:C.hash([])};
      if (checkDependencies) {if(auth.effectiveAssetBlocked)C.fail('gbp_association_inherited_asset');impact=await dependencies(source,auth,transaction,{allowReviewChange});}
      const fp=await sourceFingerprint(source,impact,auth,input,transaction);if(expectedFingerprint&&fp!==expectedFingerprint)C.fail('gbp_association_scope_changed');
      return {...auth,...impact,source,sourceFingerprint:fp};
    });
  }
  async function load(id,transaction) {if (!C.UUID.test(id)) C.fail(); const row=await m().BusinessProfileAssociationRequest.findByPk(id,opts(transaction)); if (!row) C.fail('gbp_association_not_found'); return row;}
  async function requestContext(input,row,transaction,{sourceRequired=true,originalSession=true,cleanup=false}={}) {
    const auth=await authority(input,transaction,{cleanup});
    if(sourceRequired&&auth.effectiveAssetBlocked)C.fail('gbp_association_inherited_asset');
    if (Number(row.clinica_id) !== Number(input.clinicId) || Number(row.google_connection_id) !== Number(input.connectionId) || row.scope_key !== input.scopeKey || row.google_user_id !== auth.scope.google_user_id || row.connection_ref !== auth.scope.connection_ref || row.scope_ref !== auth.scope.scope_ref || !cleanup&&(row.authority_digest !== auth.authorityDigest || row.oauth_binding_digest !== auth.oauthDigest)) C.fail('gbp_association_scope_changed');
    if (!originalSession&&sourceRequired&&Number(row.actor_user_id)!==Number(input.actorId)) C.fail('gbp_association_original_session_required');
    if (originalSession && (Number(row.actor_user_id) !== Number(input.actorId) || row.session_ref !== input.sessionRef || new Date(row.session_expires_at).getTime() !== input.sessionExpiresAt)) C.fail('gbp_association_original_session_required');
    if(sourceRequired){const source=await current(input,transaction);const saved=C.object(row.target_snapshot);const impact=await dependencies(source,auth,transaction,{allowReviewChange:saved.reviewDestinationChangeAccepted===true});if(saved.reviewCampaignImpactDigest&&saved.reviewCampaignImpactDigest!==impact.reviewCampaignImpactDigest)C.fail('gbp_association_review_impact_changed');if(await sourceFingerprint(source,impact,auth,input,transaction,row.target_mapping_id)!==row.source_fingerprint)C.fail('gbp_association_scope_changed');if(saved.reassociation)await Reassociation.inspectSource({models:m(),proof:saved.reassociation,accountId:row.account_id,locationId:row.location_id,targetClinic:auth.clinic,targetConnectionRef:auth.scope.connection_ref,targetConnectionId:auth.scope.google_connection_id,actorId:input.actorId,transaction});}
    const revoked=cleanup ? [] : await m().BusinessProfileBrokerRevocation.findAll({...opts(transaction),raw:true,attributes:['external_location_id'],where:{external_location_id:{[Op.in]:[row.location_id,...(row.previous_asset_ref ? [row.previous_asset_ref.split(':')[2]] : [])]}}});
    if (revoked.length) C.fail('asset_revoked'); return auth;
  }
  async function targetRow(row,transaction,active=false) {
    const target=await m().ClinicBusinessLocation.findByPk(Number(row.target_mapping_id),opts(transaction));
    const registry=await m().BusinessProfileBrokerBinding.findByPk(row.location_id,opts(transaction));
    const saved=C.object(row.target_snapshot);
    const binding=saved.generationId?await m().BusinessProfileBrokerBindingGeneration.findByPk(saved.generationId,opts(transaction)):registry;
    if(saved.generationId&&(!registry||!binding||Number(binding.mapping_id)!==Number(row.target_mapping_id)||binding.generation_id!==saved.generationId||binding.previous_asset_ref!==row.previous_asset_ref
      ||registry.current_generation_id!==(active?saved.generationId:(saved.previousGenerationId??null))))C.fail('broker_binding_invalid');
    if (!target || !binding || Number(target.clinica_id) !== Number(row.clinica_id) || Number(target.google_connection_id) !== Number(row.google_connection_id) || C.location(target.location_id) !== row.location_id || target.broker_read_connection_ref !== row.connection_ref || target.broker_read_asset_ref !== `gbp:${row.account_id}:${row.location_id}` || !!target.is_active !== active || binding.state !== (active ? 'active' : 'staged') || binding.association_attempt_id !== row.attempt_id || binding.connection_ref !== row.connection_ref || binding.asset_ref !== target.broker_read_asset_ref || Number(binding.clinica_id) !== Number(row.clinica_id) || Number(binding.google_connection_id) !== Number(row.google_connection_id)) C.fail('broker_binding_invalid');
    return {target,binding,registry};
  }
  const release = async (row,patch,transaction) => {await row.update({...patch,updated_at:now(),lease_token:null,lease_until:null,next_attempt_at:now()},opts(transaction));return plain(row);};
  const owned=async(claim,transaction)=>{const row=await load(claim.attempt_id,transaction); if (row.lease_token !== claim.lease_token || new Date(row.lease_until).getTime() <= now().getTime() || row.state !== claim.state) C.fail('gbp_association_busy'); return row;};
  return {snapshot,
    async history(input,id) {return trans(async transaction=>{await authority(input,transaction,{cleanup:true}); const rows=id ? [await load(id,transaction)] : await m().BusinessProfileAssociationRequest.findAll({...opts(transaction),where:{scope_key:input.scopeKey},order:[['requested_at','DESC'],['attempt_id','ASC']],limit:26});
      const valid=rows.filter(row=>Number(row.clinica_id) === Number(input.clinicId) && Number(row.google_connection_id) === Number(input.connectionId)); if (id && valid.length !== 1) C.fail('gbp_association_not_found'); return id ? plain(valid[0]) : {rows:valid.slice(0,25).map(plain),hasMore:valid.length>25};});},
    async enqueue(input,payload,candidate,expectedAuthority) {return trans(async transaction=>{
      const auth=await authority(input,transaction); if (auth.authorityDigest !== expectedAuthority) C.fail('gbp_association_scope_changed');
      const old=await m().BusinessProfileAssociationRequest.findByPk(payload.attemptId,opts(transaction));
      if (old) {if (old.source_fingerprint !== payload.sourceFingerprint || old.account_id !== C.resource(payload.accountName,'accounts') || old.location_id !== C.resource(payload.locationName,'locations') || (C.object(old.target_snapshot).reviewDestinationChangeAccepted===true)!==(payload.reviewDestinationChangeAccepted===true)) C.fail('idempotency_conflict'); await requestContext(input,old,transaction,{sourceRequired:!['retire_pending','active','cancelled'].includes(old.state),originalSession:false}); return plain(old);}
      const source=await current(input,transaction);const impact=await dependencies(source,auth,transaction,{allowReviewChange:payload.reviewDestinationChangeAccepted===true});if(await sourceFingerprint(source,impact,auth,input,transaction)!==payload.sourceFingerprint)C.fail('gbp_association_scope_changed');if(impact.reviewDestinationChangeRequired&&(!candidate.rawLocation?.metadata?.newReviewUri||typeof candidate.rawLocation.metadata.newReviewUri!=='string'))C.fail('gbp_association_review_link_unavailable');
      if (source && C.location(source.location_id) === C.resource(payload.locationName,'locations')) C.fail('gbp_association_already_current');
      const pending=await m().BusinessProfileAssociationRequest.findOne({...opts(transaction),where:{scope_key:input.scopeKey,state:{[Op.notIn]:['active','cancelled']}}}); if (pending) C.fail('gbp_association_busy');
      const accountId=C.resource(payload.accountName,'accounts'), locationId=C.resource(payload.locationName,'locations');
      if (!auth.scope.account_ids.includes(accountId) || auth.scope.location_ids.length && !auth.scope.location_ids.includes(locationId) || candidate.accountName !== payload.accountName || candidate.locationName !== payload.locationName) C.fail('gbp_association_target_forbidden');
      if (await m().BusinessProfileBrokerRevocation.findByPk(locationId,{...opts(transaction),attributes:['external_location_id']})) C.fail('asset_revoked');
      const existing=bounded(await m().ClinicBusinessLocation.findAll({...opts(transaction),where:{[Op.or]:[{location_id:{[Op.in]:[locationId,'locations/' + locationId]}},{location_id:{[Op.like]:'%/locations/' + locationId}}]},limit:1001}));
      const existingBinding=await m().BusinessProfileBrokerBinding.findByPk(locationId,opts(transaction));
      let predecessor=null,cancelledCandidate=false;
      if (existing.length || existingBinding) {
        const prior=existingBinding?.association_attempt_id?await m().BusinessProfileAssociationRequest.findByPk(existingBinding.association_attempt_id,opts(transaction)):null;
        const cancelled=existing.length?await m().BusinessProfileAssociationRequest.findAll({...opts(transaction),where:{target_mapping_id:{[Op.in]:existing.map(v=>Number(v.id))},state:'cancelled'},attributes:['target_mapping_id'],raw:true,limit:1001}):[];
        cancelledCandidate=existing.length>0&&existingBinding?.state==='retired'&&prior?.state==='cancelled'&&existing.some(v=>Number(prior.target_mapping_id)===Number(v.id))
          &&existing.every(v=>!v.is_active&&Number(v.clinica_id)===Number(input.clinicId)&&Number(v.google_connection_id)===Number(input.connectionId)
            &&v.broker_read_connection_ref===auth.scope.connection_ref&&v.broker_read_asset_ref===`gbp:${accountId}:${locationId}`&&cancelled.some(r=>Number(r.target_mapping_id)===Number(v.id)))
          &&existingBinding.connection_ref===auth.scope.connection_ref&&existingBinding.asset_ref===`gbp:${accountId}:${locationId}`;
        if(!cancelledCandidate){if(!candidate.reassociation||!existingBinding)C.fail('gbp_association_location_in_use');
          predecessor=await Reassociation.inspectSource({models:m(),proof:candidate.reassociation,accountId,locationId,targetClinic:auth.clinic,targetConnectionRef:auth.scope.connection_ref,targetConnectionId:auth.scope.google_connection_id,actorId:input.actorId,transaction});}
      }
      if(candidate.reassociation&&!predecessor)C.fail('gbp_association_scope_changed');
      const generationId=predecessor||cancelledCandidate?randomUUID():null;
      const target=await m().ClinicBusinessLocation.create({clinica_id:Number(input.clinicId),google_connection_id:Number(input.connectionId),location_id:'locations/' + locationId,location_name:candidate.name,store_code:candidate.storeCode,is_verified:candidate.isVerified,is_suspended:false,is_active:false,sync_status:'pending',last_synced_at:null,raw_payload:{...candidate.rawLocation,clinicaclick_association_attempt_id:payload.attemptId},broker_read_connection_ref:auth.scope.connection_ref,broker_read_asset_ref:`gbp:${accountId}:${locationId}`},{transaction,logging:false});
      const date=now(); const row=await m().BusinessProfileAssociationRequest.create({attempt_id:payload.attemptId,scope_key:input.scopeKey,clinica_id:Number(input.clinicId),google_connection_id:Number(input.connectionId),google_user_id:auth.scope.google_user_id,connection_ref:auth.scope.connection_ref,scope_ref:auth.scope.scope_ref,account_id:accountId,location_id:locationId,previous_asset_ref:source?.broker_read_asset_ref || null,source_mapping_id:source?.id || null,target_mapping_id:target.id,source_fingerprint:payload.sourceFingerprint,authority_digest:auth.authorityDigest,oauth_binding_digest:auth.oauthDigest,current_snapshot:C.target(source),target_snapshot:{...candidate,...impact,reviewDestinationChangeAccepted:payload.reviewDestinationChangeAccepted===true,mappingId:Number(target.id)},actor_user_id:Number(input.actorId),session_ref:input.sessionRef,session_expires_at:new Date(input.sessionExpiresAt),prepare_request_id:randomUUID(),activate_request_id:randomUUID(),retire_request_id:randomUUID(),abort_request_id:randomUUID(),command_history:[],state:'prepare_pending',requested_at:date,updated_at:date,next_attempt_at:date,attempts:0,lease_token:null,lease_until:null,last_error:null},{transaction,logging:false});
      const newBinding={external_location_id:locationId,connection_ref:row.connection_ref,asset_ref:`gbp:${accountId}:${locationId}`,clinica_id:Number(input.clinicId),google_connection_id:Number(input.connectionId),state:'staged',association_attempt_id:row.attempt_id};
      if(generationId){
        const {ancestors=[],...immediate}=predecessor||{};const predecessors=predecessor?[immediate,...ancestors]:[];
        const saved={...C.object(row.target_snapshot),generationId,previousGenerationId:existingBinding.current_generation_id??null,predecessors,...(predecessor?{reassociation:candidate.reassociation,predecessor:immediate}:{})};
        await row.update({target_snapshot:saved},opts(transaction));
        await m().BusinessProfileBrokerBindingGeneration.create({generation_id:generationId,mapping_id:Number(target.id),...newBinding,scope_ref:row.scope_ref,previous_asset_ref:row.previous_asset_ref,
          source_fingerprint:row.source_fingerprint,predecessor:predecessors,reassociation:predecessor?candidate.reassociation:null,proof_digest:predecessor?Reassociation.digestFor(row,candidate.reassociation):null,created_at:date,updated_at:date},{transaction,logging:false});
      }
      else if (existingBinding) C.fail('gbp_association_location_in_use');
      else await m().BusinessProfileBrokerBinding.create(newBinding,{transaction,logging:false});
      await record(row,'association_requested',transaction); await requestContext(input,row,transaction); return plain(row);
    });},
    async transition(input,id,kind) {return trans(async transaction=>{await authority(input,transaction,{cleanup:kind==='cancel'});const row=await load(id,transaction);
      if (kind === 'confirm' && ['activate_pending','broker_active','retire_pending','active'].includes(row.state)) {await requestContext(input,row,transaction,{sourceRequired:!['retire_pending','active'].includes(row.state),originalSession:false});return plain(row);}
      if (kind === 'cancel' && row.state === 'cancelled') {await requestContext(input,row,transaction,{sourceRequired:false,originalSession:false,cleanup:true});return plain(row);}
      if(kind==='cancel'&&Number(row.actor_user_id)!==Number(input.actorId))C.fail('gbp_association_original_session_required');
      await requestContext(input,row,transaction,{sourceRequired:kind!=='cancel',originalSession:kind==='confirm',cleanup:kind==='cancel'});
      if (row.lease_until && new Date(row.lease_until)>now()) C.fail('gbp_association_busy');
      if (kind === 'confirm' ? row.state !== 'prepared' : !['prepare_pending','prepared','activate_pending','broker_active','cancel_pending'].includes(row.state)) C.fail('gbp_association_not_ready');
      if(kind==='cancel'){const history=C.array(row.command_history);if(history.length>=100)C.fail('gbp_association_limit');await row.update({command_history:[...history,{kind:'cancel_intent',actorId:Number(input.actorId),sessionRef:input.sessionRef,requestedAt:now().toISOString()}]},opts(transaction));}
      return release(row,{state:kind === 'confirm' ? 'activate_pending' : 'cancel_pending',last_error:null},transaction);
    });},
    async claim(input,id) {return trans(async transaction=>{await authority(input,transaction,{cleanup:true});const row=await load(id,transaction);
      if (!C.PENDING.includes(row.state)) return null;
      await requestContext(input,row,transaction,{sourceRequired:!['retire_pending','cancel_pending'].includes(row.state),originalSession:row.state==='prepare_pending',cleanup:row.state==='cancel_pending'});
      if (row.lease_until && new Date(row.lease_until)>now() || new Date(row.next_attempt_at)>now()) return null;
      await row.update({lease_token:randomUUID(),lease_until:new Date(now().getTime()+90000),attempts:Math.min(1000000000,Number(row.attempts)+1)},opts(transaction));return plain(row);
    });},
    async assertClaim(input,claim) {return trans(async transaction=>{await authority(input,transaction,{cleanup:true});const row=await owned(claim,transaction);await requestContext(input,row,transaction,{sourceRequired:!['retire_pending','cancel_pending'].includes(row.state),originalSession:row.state==='prepare_pending',cleanup:row.state==='cancel_pending'});await targetRow(row,transaction,row.state === 'retire_pending');return true;});},
    async rotateCommand(input,claim,kind) {if(!['prepare','activate','retire','abort'].includes(kind))C.fail();return trans(async transaction=>{await authority(input,transaction,{cleanup:true});const row=await owned(claim,transaction);await requestContext(input,row,transaction,{sourceRequired:!['retire_pending','cancel_pending'].includes(row.state),originalSession:row.state==='prepare_pending',cleanup:row.state==='cancel_pending'});const history=C.array(row.command_history);if(history.length>=100)C.fail('gbp_association_limit');const field=kind+'_request_id';await row.update({[field]:randomUUID(),command_history:[...history,{kind,requestId:row[field],retiredAt:now().toISOString()}]},opts(transaction));return plain(row);});},
    async prepared(input,claim) {return trans(async transaction=>{await authority(input,transaction);const row=await owned(claim,transaction);await requestContext(input,row,transaction);await targetRow(row,transaction);await record(row,'association_prepared',transaction);return release(row,{state:'prepared',last_error:null},transaction);});},
    async activated(input,claim) {return trans(async transaction=>{await authority(input,transaction);const row=await owned(claim,transaction);await requestContext(input,row,transaction,{originalSession:false});await targetRow(row,transaction);return release(row,{state:'broker_active',last_error:null},transaction);});},
    async swap(input,claim) {return trans(async transaction=>{await authority(input,transaction);const row=await owned(claim,transaction);const auth=await requestContext(input,row,transaction,{originalSession:false});const {target,binding,registry}=await targetRow(row,transaction);const old=await current(input,transaction);await dependencies(old,auth,transaction,{allowReviewChange:C.object(row.target_snapshot).reviewDestinationChangeAccepted===true});
      if (old) {await oldRowUpdate(old,{is_active:false},transaction);const r=await m().BusinessProfileBrokerBinding.findByPk(C.location(old.location_id),opts(transaction));const b=r?.current_generation_id?await m().BusinessProfileBrokerBindingGeneration.findByPk(r.current_generation_id,opts(transaction)):r;if (!b || b.state !== 'active') C.fail('broker_binding_invalid');await b.update({state:'retired'},opts(transaction));}
      await target.update({is_active:true,sync_status:'pending'},opts(transaction));await binding.update({state:'active'},opts(transaction));
      if(C.object(row.target_snapshot).generationId){const saved=C.object(row.target_snapshot);const [count]=await m().BusinessProfileBrokerBinding.update({current_generation_id:saved.generationId},{...opts(transaction),where:{external_location_id:row.location_id,current_generation_id:saved.previousGenerationId??null}});if(count!==1)C.fail('gbp_association_scope_changed');}
      await record(row,'association_confirmed',transaction);return release(row,{state:'retire_pending',last_error:null},transaction);
    });},
    async retired(input,claim) {return trans(async transaction=>{await authority(input,transaction);const row=await owned(claim,transaction);await requestContext(input,row,transaction,{sourceRequired:false,originalSession:false});await targetRow(row,transaction,true);const latest=await current(input,transaction);if (Number(latest?.id)!==Number(row.target_mapping_id)) C.fail('gbp_association_scope_changed');await record(row,'association_retired',transaction);return release(row,{state:'active',last_error:null},transaction);});},
    async cancelled(input,claim) {return trans(async transaction=>{await authority(input,transaction,{cleanup:true});const row=await owned(claim,transaction);await requestContext(input,row,transaction,{sourceRequired:false,originalSession:false,cleanup:true});const {target,binding}=await targetRow(row,transaction);await target.update({is_active:false},opts(transaction));await binding.update({state:'retired'},opts(transaction));const cancel=C.array(row.command_history).filter(v=>v.kind==='cancel_intent').at(-1);if(!cancel||Number(cancel.actorId)!==Number(row.actor_user_id)||!C.UUID.test(cancel.sessionRef))C.fail('gbp_association_invalid');await record(row,'association_cancelled',transaction,{actorId:cancel.actorId,sessionRef:cancel.sessionRef});return release(row,{state:'cancelled',last_error:null},transaction);});},
    async retry(claim,error) {return trans(async transaction=>{const row=await owned(claim,transaction);const code=typeof error === 'string' && /^[a-z0-9_]{1,64}$/.test(error) ? error : 'gbp_association_unavailable';const r=await release(row,{last_error:code},transaction);await row.update({next_attempt_at:new Date(now().getTime()+Math.min(60000,1000*2**Math.min(Number(row.attempts),6)))},opts(transaction));return {...r,next_attempt_at:row.next_attempt_at};});},
  };
  async function oldRowUpdate(row,patch,transaction) {const [count]=await m().ClinicBusinessLocation.update(patch,{...opts(transaction),where:{id:Number(row.id),is_active:true,google_connection_id:Number(row.google_connection_id),broker_read_connection_ref:row.broker_read_connection_ref,broker_read_asset_ref:row.broker_read_asset_ref}});if (count !== 1) C.fail('gbp_association_scope_changed');}
}
module.exports = {createRepositoryForAssociation};
