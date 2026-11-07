'use strict';
// Owned --skip-networking mysqld only. OAuth inventories/receipts and all
// credentials are fictitious; the real recovery/authority/binding/audit run.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {DataTypes:D,Op}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async({sql,models,report})=>{
  const C=require('../../services/metaMarketingOAuth.contract'),E=require('../../services/metaMarketingEnrollment.contract');
  const G=require('../../services/metaMarketingLegacyRecovery.service'),Discovery=require('../../../services/integrations-broker/src/meta-marketing-discovery-contract');
  let clock=Date.parse('2030-01-01T12:00:00Z'),mfa=true;const now=()=>new Date(clock);
  for(const [name,file]of[['Clinica','clinica'],['GrupoClinica','grupoclinica'],['MetaScopeBlock','metascopeblock'],['MetaConnection','MetaConecction'],
    ['MetaConnectionAssignment','metaconnectionassignment'],['ClinicMetaAsset','ClinicMetaAsset'],['GroupAssetClinicAssignment','groupassetclinicassignment'],
    ['MetaMarketingBrokerBinding','metamarketingbrokerbinding'],['MetaMarketingBrokerRevocation','metamarketingbrokerrevocation'],['PlatformAuditEvent','platformauditevent'],
    ['MetaMarketingOAuthSlot','metamarketingoauthslot'],['MetaMarketingOAuthRequest','metamarketingoauthrequest'],['MetaMarketingEnrollmentRequest','metamarketingenrollmentrequest'],
    ['MetaMarketingEnrollmentClaim','metamarketingenrollmentclaim'],['MetaMarketingEnrollmentIdentity','metamarketingenrollmentidentity'],['MetaMarketingRecovery','metamarketingrecovery']]){
    models[name]=require('../../../models/'+file)(sql,D);for(const a of Object.values(models[name].rawAttributes))delete a.references;
    models[name].refreshAttributes();await models[name].sync();
  }
  await require('../../../migrations/20260919110000-meta-marketing-enrollment-due-index').up(sql.getQueryInterface());
  await models.GrupoClinica.bulkCreate([28,29].map(id_grupo=>({id_grupo,nombre_grupo:'Fictitious group '+id_grupo})));
  await models.Clinica.bulkCreate([1,70,66,72].map(id=>({id_clinica:id,nombre_clinica:'Fictitious clinic '+id,grupoClinicaId:[1,70].includes(id)?28:29,estado_clinica:true})));
  const LEGACY='FICTITIOUS_SOURCE_TOKEN',PAGE='FICTITIOUS_SELECTED_PAGE_TOKEN',WA='FICTITIOUS_UNTOUCHED_WA_TOKEN';
  await models.MetaConnection.bulkCreate([{id:158,userId:1,metaUserId:'201',accessToken:LEGACY,credentials_external:false,broker_app_id:null},
    {id:159,userId:null,metaUserId:'201',accessToken:null,credentials_external:true,broker_app_id:'101'}]);
  const metadata={currency:'EUR',business_name:'Fictitious historical business',timezone_name:'Europe/Madrid',account_status:1};
  await models.ClinicMetaAsset.bulkCreate([
    {id:359,metaConnectionId:158,assetType:'ad_account',metaAssetId:'act_301',assignmentScope:'group',clinicaId:1,grupoClinicaId:28,isActive:true},
    {id:361,metaConnectionId:158,assetType:'facebook_page',metaAssetId:'401',assignmentScope:'group',clinicaId:1,grupoClinicaId:28,isActive:true,pageAccessToken:PAGE},
    {id:391,metaConnectionId:158,assetType:'ad_account',metaAssetId:'act_302',assignmentScope:'clinic',clinicaId:72,grupoClinicaId:null,isActive:true,additionalData:metadata},
    {id:392,metaConnectionId:158,assetType:'whatsapp_phone_number',metaAssetId:'901',assignmentScope:'clinic',clinicaId:72,isActive:true,waAccessToken:WA,whatsappAuthorizationId:randomUUID()},
  ]);
  await models.GrupoClinica.update({facebook_primary_asset_id:361},{where:{id_grupo:28}});
  await models.MetaConnectionAssignment.bulkCreate([{scopeKey:'group:28',assignmentScope:'group',grupoClinicaId:28,clinicaId:null,metaConnectionId:158,status:'active'},
    {scopeKey:'clinic:1',assignmentScope:'clinic',clinicaId:1,grupoClinicaId:null,metaConnectionId:158,status:'disconnected'},
    {scopeKey:'clinic:72',assignmentScope:'clinic',clinicaId:72,grupoClinicaId:null,metaConnectionId:158,status:'active'}]);
  await models.MetaScopeBlock.create({scope_key:'clinic:1',reason:'scope_disconnected',connection_id:158,actor_user_id:1,created_at:now()});
  const baseline=async()=>G.encode({source:await models.MetaConnection.findByPk(158,{raw:true}),wa:await models.ClinicMetaAsset.findByPk(392,{raw:true}),
    grants:await models.MetaConnectionAssignment.findAll({raw:true,order:[['id','ASC']]}),groups:await models.GrupoClinica.findAll({raw:true,order:[['id_grupo','ASC']]}),
    blocks:await models.MetaScopeBlock.findAll({raw:true}),shares:await models.GroupAssetClinicAssignment.findAll({raw:true})});
  const untouched=await baseline(),sessions={verifyReference:async(reference,options)=>{
    assert.equal(reference.userId,1);assert.equal(options.requireEmail,true);assert(options.transaction);
    if(!mfa)throw Object.assign(Error('auth_email_verification_required'),{code:'auth_email_verification_required',status:403});
  }};
  const guard=G.createRecovery({models,sessions,now,enabled:()=>true}),scope=require('../../services/metaMarketingOAuthScope.service').createScope({models,sessions,now,recoveryGuard:guard});
  const actors=[28,29].map(group=>({scopeKey:'group:'+group,actorId:1,sessionRef:randomUUID(),sessionExpiresAt:new Date(clock+7200000)}));
  const archive=path.join(report.root,'provider-metadata-four-keys.json');fs.writeFileSync(archive,JSON.stringify(metadata)+'\n',{mode:0o600});
  const [[sourcePin]]=await sql.query('SELECT SHA2(CAST(additionalData AS CHAR),256) AS digest FROM ClinicMetaAssets WHERE id=391');
  const archivePin=G.hash(fs.readFileSync(archive));
  const records=[];
  for(const group of[28,29]){
    const descriptor={version:2,scopeKey:'group:'+group,clinicIds:group===28?[1,70]:[66,72],sourceConnectionId:158,canonicalConnectionId:159,appId:'101',subjectId:'201',actorId:1,
      mappingIds:group===28?[359,361]:[391],newPageCount:group===28?0:2,cleanup:group===28?
        [{mappingId:361,fields:['pageAccessToken'],additionalDataKeys:[],additionalDataSha256:null,archiveEvidenceSha256:null,metadataDisposition:null}]
        :[{mappingId:391,fields:['additionalData'],additionalDataKeys:[...G.METADATA_KEYS],additionalDataSha256:sourcePin.digest,archiveEvidenceSha256:archivePin,metadataDisposition:'archived'}]};
    const snapshot=await sql.transaction(t=>guard.captureSnapshot(descriptor,t)),text=G.encode(snapshot);
    for(const token of[LEGACY,PAGE,WA])assert(!text.includes(token));
    records.push(await models.MetaMarketingRecovery.create({recovery_id:randomUUID(),scope_key:descriptor.scopeKey,clinic_ids:JSON.stringify(descriptor.clinicIds),
      app_id:'101',meta_user_id:'201',source_connection_id:158,canonical_connection_id:null,mapping_ids:JSON.stringify(descriptor.mappingIds),snapshot:text,snapshot_digest:G.hash(text),
      prepared_by_user_id:1,prepared_at:now(),expires_at:new Date(clock+3600000),state:'prepared'}));
  }
  assert.equal(await models.MetaMarketingRecovery.count({where:{canonical_connection_id:null}}),2);
  assert((await sql.getQueryInterface().showIndex('MetaMarketingRecoveries')).some(index=>index.unique&&index.fields.some(field=>field.attribute==='canonical_connection_id')));
  report.checks.push('Two immutable V2 snapshots share preallocated159 while historical SQL UNIQUE column staysNULL; no new DDL and no credential hydration');
  const inventories=new Map(),flows=[];
  const asset=(kind,id)=>({assetRef:'meta-'+kind+':'+id,kind,id,name:'Fictitious asset '+id,parentPageId:null,
    ...(kind==='ad_account'?{accountStatus:1,currency:'EUR',timezone:'Europe/Madrid'}:{})});
  for(let i=0;i<2;i++){
    const a=actors[i],group=i===0?28:29,clinicIds=i===0?[1,70]:[66,72],scopes=['ads_read','pages_read_engagement','pages_show_list','public_profile'];
    const slot={scope_key:a.scopeKey,connection_ref:'connection:fixture-'+group,asset_ref:'meta-enroll:'+a.scopeKey,app_id:'101',clinic_ids:JSON.stringify(clinicIds),
      scopes:JSON.stringify(scopes),redirect_uri:'https://app.example.invalid/oauth/meta/marketing/callback',expires_at:new Date(clock+7200000),state:'active'};
    await models.MetaMarketingOAuthSlot.create(slot);
    const captured=await sql.transaction(t=>scope.capture(a,t)),flowId=randomUUID();
    const candidate={versionId:flowId,digest:C.hash('FICTITIOUS_CANDIDATE_'+group),appId:'101',subjectId:'201',tokenType:'USER',scopes,
      expiresAt:clock+7200000,dataAccessExpiresAt:null,granularScopes:[]};
    const flow=await models.MetaMarketingOAuthRequest.create({flow_id:flowId,state_hash:C.hash(flowId),scope_key:a.scopeKey,connection_ref:slot.connection_ref,asset_ref:slot.asset_ref,
      app_id:'101',clinic_ids:slot.clinic_ids,scopes:slot.scopes,redirect_uri:slot.redirect_uri,slot_digest:captured.slotDigest,scope_digest:captured.scopeDigest,
      actor_user_id:1,session_ref:a.sessionRef,session_expires_at:a.sessionExpiresAt,return_origin:'https://app.example.invalid',requested_at:now(),expires_at:new Date(clock+600000),
      state:'staged',candidate_metadata:JSON.stringify(candidate),next_attempt_at:now(),completed_at:now()});
    flows.push(flow);
    const assets=(i===0?[asset('ad_account','301'),asset('facebook_page','401'),asset('ad_account','303')]
      :[asset('ad_account','302'),asset('facebook_page','501'),asset('facebook_page','502'),asset('ad_account','303')])
      .sort((a,b)=>a.assetRef.localeCompare(b.assetRef));
    inventories.set(flowId,{flowId,candidateVersionId:flowId,candidateDigest:candidate.digest,scopeDigest:flow.scope_digest,scopeKey:a.scopeKey,
      clinicSetDigest:C.hash(flow.clinic_ids),observedAt:clock,expiresAt:clock+300000,accessBlocked:true,availableKinds:Discovery.kinds(candidate),assets});
  }
  const oauth={assets:async(_actor,id)=>({inventory:inventories.get(id)})};
  const authority=require('../../services/metaMarketingEnrollmentAuthority.service').createAuthority({models,sessions,oauth,now,enabled:()=>true,recoveryGuard:guard});
  const bindings=require('../../services/metaMarketingEnrollmentBinding.service').createBindings({models,sessions,authority,now,recoveryGuard:guard});
  const review=require('../../services/metaMarketingEnrollmentReview.service').createReview({models,sessions,now,recoveryGuard:guard});
  const refs=i=>inventories.get(flows[i].flow_id).assets.filter(asset=>i===1||asset.id!=='303').map(asset=>asset.assetRef);
  mfa=false;await assert.rejects(authority.reserve(actors[0],flows[0].flow_id,refs(0)),{code:'auth_email_verification_required'});mfa=true;
  await assert.rejects(authority.reserve(actors[0],flows[0].flow_id,['meta-ad_account:301']),{code:'meta_recovery_selection_changed'});
  for(let i=0;i<2;i++){
    const r=await sql.transaction(t=>review({row:flows[i].get({plain:true}),inventory:inventories.get(flows[i].flow_id)},t));
    assert.equal(r.scopeStatus,'clear');assert(r.assets.every(asset=>asset.status==='clear'));
  }
  await assert.rejects(authority.reserve(actors[1],flows[1].flow_id,[...refs(1),'meta-ad_account:999']),{code:'meta_enrollment_invalid'});
  const cross=await models.ClinicMetaAsset.create({metaConnectionId:158,assetType:'ad_account',metaAssetId:'act_303',assignmentScope:'group',grupoClinicaId:28,
    clinicaId:null,isActive:true,pageAccessToken:'FICTITIOUS_FORBIDDEN_AD_CREDENTIAL'});
  try{await assert.rejects(authority.reserve(actors[1],flows[1].flow_id,refs(1)),{code:'meta_enrollment_asset_in_use'});}
  finally{await cross.destroy();}
  const revoked=await models.MetaMarketingBrokerRevocation.create({tuple_hash:C.hash('FICTITIOUS_NEW_AD_REVOCATION'),connection_ref:'connection:fixture-28',asset_ref:'meta-ad_account:303',
    tenant_clinic_id:1,meta_connection_id:159,meta_user_id:'201',app_id:'101',parent_page_id:null,scope_key:'group:28',clinic_ids:'[1,70]',mapping_ids:'[]',
    request_id:randomUUID(),actor_user_id:1,requested_at:now(),state:'confirmed',next_attempt_at:now()});
  try{await assert.rejects(authority.reserve(actors[1],flows[1].flow_id,refs(1)),{code:'meta_enrollment_asset_revoked'});}
  finally{await revoked.destroy();}
  assert.equal(await models.MetaMarketingEnrollmentRequest.count(),0);assert.equal(await models.MetaMarketingEnrollmentClaim.count(),0);
  report.checks.push('Fresh explicitly selected Ads are selectable; unknown inventory IDs, cross-scope credential-bearing aliases and revocation history reject before reservation; every original and exact Root-counted Pages remain mandatory');
  models.PlatformAuditEvent.addHook('beforeCreate','v2-reserve-fail',row=>{if(JSON.parse(row.body).reason==='meta_enrollment_requested')throw Error('FICTITIOUS_RESERVE_AUDIT_FAILURE');});
  try{await assert.rejects(authority.reserve(actors[0],flows[0].flow_id,refs(0)),/FICTITIOUS_RESERVE_AUDIT_FAILURE/);}finally{models.PlatformAuditEvent.removeHook('beforeCreate','v2-reserve-fail');}
  assert.equal(await models.MetaMarketingEnrollmentIdentity.count(),0);assert.equal(await models.MetaMarketingEnrollmentRequest.count(),0);
  assert.equal((await models.ClinicMetaAsset.findByPk(361)).pageAccessToken,PAGE);assert.equal(await baseline(),untouched);
  async function reserve(i){return authority.reserve(actors[i],flows[i].flow_id,refs(i));}
  async function ready(value){
    const r=E.request(value);await models.MetaMarketingEnrollmentRequest.update({state:'activate_pending',selection_digest:C.hash('FICTITIOUS_SELECTION_'+r.enrollment_id),
      prepared_at:now(),lease_token:randomUUID(),lease_until:new Date(clock+120000)},{where:{enrollment_id:r.enrollment_id}});
    return E.request(await models.MetaMarketingEnrollmentRequest.findByPk(r.enrollment_id,{raw:true}));
  }
  const receipt=row=>({enrollmentId:row.enrollment_id,flowId:row.flow_id,scopeKey:row.scope_key,scopeDigest:row.scope_digest,candidateDigest:row.candidate_digest,
    selectionDigest:row.selection_digest,clinicSetDigest:C.hash(row.clinic_ids),assets:row.selected,status:'active',accessBlocked:false,preparedAt:clock,activatedAt:clock});
  const activate=row=>sql.transaction(t=>bindings.activate(row,receipt(row),t));
  const arriaga=await ready(await reserve(0));assert.equal(arriaga.meta_connection_id,159);assert.equal(await models.MetaConnection.count(),2);
  models.PlatformAuditEvent.addHook('beforeCreate','v2-activate-fail',row=>{if(JSON.parse(row.body).reason==='meta_enrollment_activated')throw Error('FICTITIOUS_ACTIVATE_AUDIT_FAILURE');});
  try{await assert.rejects(activate(arriaga),/FICTITIOUS_ACTIVATE_AUDIT_FAILURE/);}finally{models.PlatformAuditEvent.removeHook('beforeCreate','v2-activate-fail');}
  assert.equal((await models.ClinicMetaAsset.findByPk(361)).pageAccessToken,PAGE);assert.equal(await models.MetaMarketingBrokerBinding.count(),0);
  await activate(arriaga);
  assert.equal((await models.ClinicMetaAsset.findByPk(361)).pageAccessToken,null);assert.equal((await models.ClinicMetaAsset.findByPk(359)).metaConnectionId,159);
  const committed=id=>sql.transaction(t=>bindings.committed(id,t));await committed(arriaga.enrollment_id);
  assert.equal(await baseline(),untouched);
  report.checks.push('Actual SQL audit failures roll back reservation and activation; selected Page361 token cleared only with SHA-CAS+fresh grant in successful atomic audited commit');
  const boundBS=await models.MetaMarketingRecovery.findByPk(records[1].recovery_id,{raw:true});
  assert.equal(boundBS.state,'flow_bound');assert(+boundBS.bound_at>=+boundBS.prepared_at&&+boundBS.bound_at<+boundBS.expires_at);
  const auditRepository=require('../../services/platformAudit.repository'),auditEvent=require('../../../services/platform-audit/src/event');
  const delivered=await auditRepository.drain(auditRepository.createRepository(models.PlatformAuditEvent),{
    write:async row=>({key:auditEvent.keyFor(row),digest:row.digest,versionId:'FICTITIOUS_DELIVERY_ACK'})},{now,limit:100});
  assert.equal(delivered.failed,0);assert.equal(delivered.pending,0);
  clock+=3600001;
  for(const inventory of inventories.values()){inventory.observedAt=clock;inventory.expiresAt=clock+300000;}
  mfa=false;await assert.rejects(authority.reserve(actors[1],flows[1].flow_id,refs(1)),{code:'auth_email_verification_required'});mfa=true;
  const originalCandidate=flows[1].candidate_metadata,expiredCandidate=JSON.parse(originalCandidate);expiredCandidate.expiresAt=clock-1;
  await flows[1].update({candidate_metadata:JSON.stringify(expiredCandidate)});
  try{await assert.rejects(authority.reserve(actors[1],flows[1].flow_id,refs(1)));}finally{await flows[1].update({candidate_metadata:originalCandidate});}
  const continued=await sql.transaction(t=>guard.forFlow(flows[1].get({plain:true}),t));
  assert.equal(continued.recoveryId,boundBS.recovery_id);
  assert.equal((await sql.transaction(t=>scope.revalidate(flows[1].get({plain:true}),t))).scopeDigest,flows[1].scope_digest);
  const bs=await ready(await reserve(1));assert.equal(bs.meta_connection_id,159);assert.equal(await models.MetaMarketingEnrollmentIdentity.count(),1);
  await models.ClinicMetaAsset.update({additionalData:{...metadata,currency:'USD'}},{where:{id:391},silent:true});
  await assert.rejects(activate(bs));assert.equal(await models.MetaMarketingBrokerBinding.count(),2);
  await models.ClinicMetaAsset.update({additionalData:metadata},{where:{id:391},silent:true});
  await activate(bs);const activeBS=await models.MetaMarketingEnrollmentRequest.findByPk(bs.enrollment_id,{raw:true});
  assert.equal(JSON.parse(activeBS.mapping_ids).length,4);assert(JSON.parse(activeBS.mapping_ids).includes(391));
  const adopted=await models.ClinicMetaAsset.findByPk(391,{raw:true});assert.equal(adopted.additionalData,null);assert.equal(adopted.assignmentScope,'group');
  assert.equal(adopted.grupoClinicaId,29);assert.equal(adopted.clinicaId,null);assert.equal(adopted.metaConnectionId,159);
  assert.equal(G.hash(fs.readFileSync(archive)),archivePin);assert.deepEqual(JSON.parse(fs.readFileSync(archive)),metadata);
  const fresh=await models.ClinicMetaAsset.findAll({where:{assetType:'facebook_page',metaAssetId:{[Op.in]:['501','502']}},raw:true});assert.equal(fresh.length,2);
  assert(fresh.every(page=>page.metaConnectionId===159&&page.grupoClinicaId===29&&page.pageAccessToken===null&&page.waAccessToken===null&&page.additionalData===null));
  const freshAd=await models.ClinicMetaAsset.findOne({where:{assetType:'ad_account',metaAssetId:'303'},raw:true});
  assert(freshAd&&JSON.parse(activeBS.mapping_ids).includes(freshAd.id));
  assert.equal(freshAd.metaConnectionId,159);assert.equal(freshAd.grupoClinicaId,29);assert.equal(freshAd.assignmentScope,'group');assert.equal(freshAd.clinicaId,null);
  for(const key of['pageAccessToken','waAccessToken','additionalData','whatsappAuthorizationId'])assert.equal(freshAd[key],null);
  assert.equal((await sql.transaction(t=>scope.revalidateStructure(flows[1].get({plain:true}),t))).scopeDigest,flows[1].scope_digest);
  for(const original of records){const current=await models.MetaMarketingRecovery.findByPk(original.recovery_id);for(const key of['snapshot','snapshot_digest','prepared_at','expires_at'])assert.deepEqual(current[key],original[key]);}
  for(const id of[arriaga.enrollment_id,bs.enrollment_id]){const proof=await committed(id);assert.equal(proof.recovery.canonicalConnectionId,159);assert.equal(proof.recovery.version,2);}
  assert.equal(await models.MetaMarketingRecovery.count({where:{canonical_connection_id:null,state:'active'}}),2);assert.equal(await baseline(),untouched);
  report.checks.push('BS bound before claim expiry completes reservation/activation after deadline; original MFA and candidate expiry remain enforced; freshAd303 plus exact2Pages have no credentials; ScopeDigest/snapshots/TTL and Arriaga/WA unchanged');
  const remoteStates=new Map([[arriaga.enrollment_id,'active'],[bs.enrollment_id,'active']]),controlCalls=[];
  const worker=require('../../services/metaMarketingEnrollment.service').createService({models,sessions,oauth:{...oauth,cancelAfterEnrollment:async row=>{
    assert.equal(row.enrollment_id,bs.enrollment_id);
  }},now,enabled:()=>true,workerEnabled:()=>true,client:{execute:async command=>{
    const row=E.request(await models.MetaMarketingEnrollmentRequest.findByPk(command.payload.enrollmentId,{raw:true}));
    controlCalls.push({id:row.enrollment_id,operation:command.operation});
    if(command.operation===E.E.OPERATIONS.revoke)remoteStates.set(row.enrollment_id,'revoked');
    else assert.equal(command.operation,E.E.OPERATIONS.status);
    const status=remoteStates.get(row.enrollment_id);
    return {requestId:command.requestId,replayed:false,data:{...receipt(row),status,accessBlocked:status==='revoked',
      preparedAt:+row.prepared_at,activatedAt:+row.activated_at}};
  }}});
  await models.MetaMarketingEnrollmentRequest.update({next_attempt_at:now()},{where:{enrollment_id:arriaga.enrollment_id}});
  const reconciledArriaga=await worker.run({enrollmentId:arriaga.enrollment_id});
  assert.equal(reconciledArriaga.failed,0,'Arriaga active reconciliation: '+JSON.stringify(reconciledArriaga)+' '+(await models.MetaMarketingEnrollmentRequest.findByPk(arriaga.enrollment_id)).last_error);await committed(arriaga.enrollment_id);
  assert.equal((await models.MetaMarketingRecovery.findByPk(records[0].recovery_id)).canonical_connection_id,null);
  await models.MetaConnection.create({id:160,userId:null,metaUserId:'201',accessToken:null,credentials_external:true,broker_app_id:'101'});
  await assert.rejects(committed(arriaga.enrollment_id));await models.MetaConnection.destroy({where:{id:160}});await committed(arriaga.enrollment_id);
  const retired=await sql.transaction(t=>guard.retireForScope({scope:{assignmentScope:'group',groupId:29},clinicIds:[66,72]},t));assert.equal(retired.retired,1);
  assert.equal(retired.blockedBindings,4);assert.equal(retired.deactivatedMappings,4);assert.equal((await models.MetaMarketingEnrollmentRequest.findByPk(bs.enrollment_id)).state,'revoke_pending');
  await committed(arriaga.enrollment_id);assert.equal((await models.MetaMarketingRecovery.findByPk(records[0].recovery_id)).state,'active');
  assert.equal((await models.ClinicMetaAsset.findByPk(361)).isActive,true);assert.equal(await baseline(),untouched);
  await assert.rejects(sql.transaction(t=>guard.assertActive({enrollmentId:bs.enrollment_id},t)),{code:'meta_recovery_retired'});
  const reconciledBS=await worker.run({enrollmentId:bs.enrollment_id});
  assert.equal(reconciledBS.failed,0,'BS withdrawal reconciliation: '+JSON.stringify(reconciledBS)+' '+(await models.MetaMarketingEnrollmentRequest.findByPk(bs.enrollment_id)).last_error);
  assert.equal((await models.MetaMarketingEnrollmentRequest.findByPk(bs.enrollment_id)).state,'revoked');
  assert.equal(controlCalls.filter(call=>call.operation===E.E.OPERATIONS.revoke).length,1);
  assert.equal(controlCalls.find(call=>call.operation===E.E.OPERATIONS.revoke).id,bs.enrollment_id);
  await committed(arriaga.enrollment_id);assert.equal(await baseline(),untouched);
  report.checks.push('Unreviewed extra canonical rejected; withdrawal/reconcile of BS affects only its4 assets and outbox, preserves Arriaga/source158/WA/grants/primaryrefs/shares/tombstones and immutable snapshots');
  report.checks.push('Actual unchanged enrollment worker reconciles active Arriaga with SQL canonicalNULL and completes BS-only status/revoke/control settlement without treating NULL as inactive or revoking the shared connection');
  const serialized=JSON.stringify(await models.MetaMarketingRecovery.findAll({raw:true}));for(const token of[LEGACY,PAGE,WA])assert(!serialized.includes(token));
  report.v2={sharedCanonical:159,sqlCanonicalNullGenerations:2,legacyMappingsAdopted:3,newPages:2,newAds:1,realProvider:false,sourceAndWhatsappUnchanged:true};
  report.pool={inUse:sql.connectionManager.pool.using,waiting:sql.connectionManager.pool.waiting};assert.deepEqual(report.pool,{inUse:0,waiting:0});
}).catch(error=>{process.stderr.write('META_RECOVERY_V2_OWNED_MYSQL_FAILED '+String(error.code||error.name)+'\n');process.exitCode=1;});
