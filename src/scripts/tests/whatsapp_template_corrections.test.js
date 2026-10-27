'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function sourceFunction(file,name,dependencies){
  const source=fs.readFileSync(require.resolve(file),'utf8'),assignment=source.indexOf('exports.'+name+' =');
  const start=assignment>=0?source.indexOf('async ',assignment):source.indexOf('async function '+name+'(');
  assert(start>=0,'Native function must exist');
  const boundaries=(assignment>=0?['\nexports.']:['\nasync function ','\nfunction ']).map(marker=>source.indexOf(marker,start+10)).filter(index=>index>=0);
  const code=source.slice(start,Math.min(...boundaries)).trim().replace(/;$/,'');
  return vm.runInNewContext('('+code+')',{console:{error(){},warn(){}},structuredClone,Map,Set,Date,...dependencies});
}
function response(){return {statusCode:200,status(v){this.statusCode=v;return this;},json(v){this.body=v;return this;}};}
const ownership=require('../../lib/whatsapp-template-ownership');
test('administrative selective preparation preserves exact sender scope and uses the existing checkpointed catalog job',async()=>{
  let admin=true,accesses=0,resolutions=0;const queued=[];
  const prepare=sourceFunction('../../controllers/whatsapp.controller','createTemplatesFromCatalog',{
    assertAdmin:(_req,res)=>{if(!admin)res.status(403).json({error:'forbidden'});return admin;},
    assertWhatsappTemplateClinicAccess:async()=>{accesses++;},
    resolveWabaFromContext:async input=>{resolutions++;assert.equal(input.clinicId,72);return {
      wabaId:'TESTONLY_waba',clinicaId:72,grupoClinicaId:29,assignmentScope:'clinic'};},
    require:name=>{assert.equal(name,'../services/whatsappTemplates.service');return {enqueueCreateTemplatesJob:async input=>{queued.push(input);return {id:1};}};},
  });
  const req={query:{clinic_id:'72'},body:{catalog_template_ids:[20,28,29,30,20]},userData:{userId:1}};
  const res=response();await prepare(req,res);assert.equal(res.statusCode,200);assert.equal(res.body.jobId,1);
  assert.deepEqual([...queued[0].catalogTemplateIds],[20,28,29,30]);
  assert.equal(queued[0].wabaId,'TESTONLY_waba');assert.equal(queued[0].clinicId,72);assert.equal(queued[0].assignmentScope,'clinic');
  assert.equal(accesses,1);assert.equal(resolutions,1);
  for(const ids of [[],[0],[-1],['20'],[20.1],null,{},Array(101).fill(20)]){
    const invalid=response();await prepare({...req,body:{catalog_template_ids:ids}},invalid);
    assert.equal(invalid.statusCode,400);assert.equal(invalid.body.error,'catalog_template_ids_invalid');
  }
  admin=false;const denied=response();await prepare(req,denied);assert.equal(denied.statusCode,403);
  assert.equal(queued.length,1);assert.equal(accesses,1);assert.equal(resolutions,1);
  const ordinary=response();await prepare({...req,body:{}},ordinary);assert.equal(ordinary.statusCode,200);
  assert.equal(queued[1].catalogTemplateIds,undefined);
});
test('native job routes custom reconciliation only to the scoped reconciler, never to catalog propagation',async()=>{
  const calls=[];
  const run=sourceFunction('../../services/jobExecutor.service','runWhatsappTemplateCreateJob',{
    whatsappTemplatesService:{reconcileClinicCustomTemplates:async input=>{calls.push(input);return {copied:1};},
      createTemplatesFromCatalog:()=>assert.fail('unrelated catalog provisioning'),
      propagateCatalogTemplateToAllClinics:()=>assert.fail('global propagation')},
  });
  const payload={mode:'reconcile_clinic_custom',wabaId:'TESTONLY',clinicId:58,assignmentScope:'clinic'};
  assert.equal((await run(payload)).status,'completed');assert.equal(calls[0],payload);
});
test('native propagation routes its coordinator and account children with the actual claimed JobRequest',async()=>{
  const calls=[],claim={id:1,status:'running',attempts:1};
  const run=sourceFunction('../../services/jobExecutor.service','runWhatsappTemplateCreateJob',{
    whatsappTemplatesService:{runCatalogPropagationJob:async(payload,job)=>{calls.push([payload,job]);return {status:'waiting',backoffMs:30000};},
      propagateCatalogTemplateToAllClinics:()=>assert.fail('global provider loop must not run inside the parent')},
  });
  for(const mode of ['propagate_catalog_item','propagate_catalog_target']) {
    const payload={mode,templateCatalogId:20};const result=await run(payload,claim);
    assert.equal(result.status,'waiting');assert.equal(calls.at(-1)[0],payload);assert.equal(calls.at(-1)[1],claim);
  }
});
test('catalog activation also reconciles custom templates under its lease, but selective template updates never do',async()=>{
  let custom=0,releases=0;
  const create=sourceFunction('../../services/whatsappTemplates.service','createTemplatesFromCatalog',{
    resolveWabaAssetById:async()=>({whatsappAuthorizedBinding:{}}),db:{sequelize:{}},
    acquireWabaCatalogCreationLease:async()=>({acquired:true,release:async()=>{releases++;}}),
    syncTemplatesForWaba:async()=>{},createTemplatesFromCatalogWithLease:async()=>({connected:1}),
    reconcileClinicCustomTemplatesWithLease:async()=>{custom++;return {copied:1};},
  });
  await create({wabaId:'TESTONLY',clinicId:58,assignmentScope:'clinic'});assert.equal(custom,1);assert.equal(releases,1);
  await create({wabaId:'TESTONLY',clinicId:58,assignmentScope:'clinic',catalogTemplateIds:[119]});
  assert.equal(custom,1);assert.equal(releases,2);
});
test('catalog read computes real broker-only coverage without a Meta request or writes',async()=>{
  const coverage=require('../../lib/whatsapp-template-catalog-coverage');
  const asset={id:1,assetType:'whatsapp_phone_number',assignmentScope:'clinic',clinicaId:58,wabaId:'101',phoneNumberId:'201',isActive:true};
  const list=sourceFunction('../../controllers/whatsapp.controller','listCatalog',{
    ...coverage,assertAdmin:()=>true,Op:{in:Symbol.for('in')},
    WhatsappTemplateCatalog:{findAll:async()=>[{id:119,name:'TESTONLY',is_generic:true,components:[{type:'BODY',text:'TESTONLY'}],propagation_state:'failed'}]},
    WhatsappTemplateCatalogDiscipline:{},WhatsappTemplate:{findAll:async()=>[{id:2,catalog_template_id:119,name:'TESTONLY',waba_id:'101',
      language:'es',status:'APPROVED',meta_template_id:'TESTONLY-meta',components:[{type:'BODY',text:'TESTONLY'}]}]},
    Clinica:{findAll:async()=>[{id_clinica:58,grupoClinicaId:5}]},ClinicMetaAsset:{findAll:async()=>[asset]},
    db:{sequelize:{literal:()=>null},WhatsappChannelBinding:{findAll:async()=>[]}},
    AutomationFlowCatalog:{findAll:async()=>[]},loadAutomationCatalogLinkedTemplates:async()=>new Map(),
    require:name=>{assert.equal(name,'../lib/whatsappAuthorizedBrokerClient');return {
      configuration:()=>({bindings:[{clinicId:58,assetId:1}]}),binding:async()=>({clinicId:58,assetId:1,phoneId:'201',wabaId:'101',sendEnabled:true}),
    };},
  });
  const res=response();await list({},res);assert.equal(res.statusCode,200);
  assert.equal(res.body[0].approved_count,1);assert.equal(res.body[0].propagation_state,'completed');assert.equal(res.body[0].approved,true);
});
test('native all-sender listing identifies both roles/WABAs, merges same-WABA copies, filters owner and inactive catalog without provider calls',async()=>{
  const assets=[{id:1,phoneNumberId:'first',wabaId:'waba1',metaAssetName:'TESTONLY 1',isActive:true},
    {id:2,phoneNumberId:'second',wabaId:'waba2',metaAssetName:'TESTONLY 2',isActive:true}];
  const templates=[{id:10,waba_id:'waba1',origin:'custom',name:'TESTONLY',created_by_user_id:1},
    {id:11,waba_id:'waba2',origin:'custom',name:'TESTONLY',created_by_user_id:1},
    {id:12,waba_id:'waba2',origin:'custom',created_by_user_id:2},
    {id:13,waba_id:'waba2',origin:'catalog',catalog_template_id:1,catalog:{is_active:false}}];
  let authorized=0,scopeAllowed=true;
  const list=sourceFunction('../../controllers/whatsapp.controller','listTemplatesForClinic',{
    ...ownership,isWhatsappGlobalAdmin:()=>false,assertWhatsappTemplateClinicAccess:async()=>{if(!scopeAllowed)throw Object.assign(Error('scope'),{code:'whatsapp_template_clinic_scope_forbidden'});},
    whatsappService:{resolvePhoneAssetByClinic:async()=>assets[0]},ClinicMetaAsset:{findByPk:async id=>assets.find(a=>a.id===id)},
    whatsappChannelBindingsService:{listClinicBindings:async()=>[{asset_id:1,role:'primary'},{asset_id:2,role:'secondary'}],applyBindingToAsset:(a,b)=>({...a,role:b.role})},
    resolveWabaFromContext:async({phoneNumberId})=>{authorized++;return assets.find(a=>a.phoneNumberId===phoneNumberId);},
    WhatsappTemplate:{findAll:async({where})=>templates.filter(t=>t.waba_id===where.waba_id)},WhatsappTemplateCatalog:{},
    buildWhatsappTemplateUsageMap:async()=>new Map(),resolveWhatsappRouting:a=>({role:a.role||'primary'}),
    buildWhatsappTemplateVariableContract:()=>[],getWhatsappTemplateUsages:()=>[],isReviewWorkflowWhatsappTemplate:()=>false,
    require:name=>{assert.equal(name,'../lib/whatsappManualDisconnect');return {current:()=>null};},
  });
  const req={query:{clinic_id:'1',all_senders:'1'},userData:{userId:1}},res=response();await list(req,res);
  assert.equal(res.statusCode,200);assert.equal(authorized,2);assert.deepEqual([...res.body.map(t=>t.id)],[10,11]);
  assert.equal(res.body[1].senders[0].role,'secondary');assert.equal(res.body[1].effective_phone_number_id,'second');
  assets[1].wabaId='waba1';const merged=response();await list(req,merged);
  assert.equal(merged.body.length,1);assert.equal(merged.body[0].senders.length,2);
  scopeAllowed=false;const denied=response();await list(req,denied);assert.equal(denied.statusCode,403);
});
test('native custom controller authorizes each exact predecessor and reports partial replica results instead of claiming complete submission',async()=>{
  const assets=[{wabaId:'101',phoneNumberId:'first',waAccessToken:'TESTONLY'},{wabaId:'102',phoneNumberId:'second',waAccessToken:'TESTONLY'}];
  let foreign=false;const inputs=[];
  const create=sourceFunction('../../controllers/whatsapp.controller','createCustomTemplate',{
    assertWhatsappTemplateClinicAccess:async()=>{},isWhatsappGlobalAdmin:()=>false,
    resolveWabaFromContext:async({phoneNumberId})=>assets.find(a=>a.phoneNumberId===phoneNumberId),
    WhatsappTemplate:{findByPk:async id=>({id,created_by_user_id:foreign?2:1,clinic_id:1,waba_id:id===11?'101':'102'})},
    buildWhatsappTemplateVariableContract:()=>[],getWhatsappTemplateUsages:()=>[],
    require:name=>{assert.equal(name,'../services/whatsappTemplates.service');return {createCustomTemplateForClinic:async input=>{
      inputs.push(input);if(input.wabaId==='102')throw Object.assign(Error('TESTONLY timeout'),{code:'outcome_unknown'});
      return {submitted:true,row:{id:21,name:'TESTONLY pinned',language:'es',status:'PENDING'}};
    }};},
  });
  const req={query:{},userData:{userId:1},body:{clinic_id:1,display_name:'TESTONLY',body_text:'TESTONLY hello',
    phone_number_ids:['first','second'],replace_template_ids:[11,12],request_id:'TESTONLY-request'}};
  const res=response();await create(req,res);assert.equal(res.statusCode,201);assert.equal(res.body.submitted,false);
  assert.equal(res.body.replicas.length,2);assert.equal(res.body.replicas[1].submitted,false);
  assert.equal(inputs[0].replaceTemplateId,11);assert.equal(inputs[1].replaceTemplateId,12);
  assert.deepEqual([...inputs[0].replacementTemplateIds],[11,12]);
  assert.equal(inputs[1].technicalName,'TESTONLY pinned');
  foreign=true;const denied=response();await create(req,denied);assert.equal(denied.statusCode,403);assert.equal(inputs.length,2);
});
test('new custom templates default to configured active phones, excluding a manually disconnected predecessor',async()=>{
  const assets=[{id:1,wabaId:'101',phoneNumberId:'first',isActive:true,waAccessToken:'TESTONLY'},
    {id:2,wabaId:'102',phoneNumberId:'second',isActive:true,waAccessToken:'TESTONLY'},
    {id:3,wabaId:'103',phoneNumberId:'retired',isActive:true,manual:true}];const targets=[];
  const create=sourceFunction('../../controllers/whatsapp.controller','createCustomTemplate',{
    assertWhatsappTemplateClinicAccess:async()=>{},isWhatsappGlobalAdmin:()=>false,
    whatsappChannelBindingsService:{listClinicBindings:async()=>assets.map(a=>({asset_id:a.id}))},
    ClinicMetaAsset:{findByPk:async id=>assets.find(a=>a.id===id)},
    resolveWabaFromContext:async({phoneNumberId})=>assets.find(a=>a.phoneNumberId===phoneNumberId),
    buildWhatsappTemplateVariableContract:()=>[],getWhatsappTemplateUsages:()=>[],
    require:name=>name==='../lib/whatsappManualDisconnect'?{current:asset=>asset.manual}:name==='../services/whatsappTemplates.service'
      ?{createCustomTemplateForClinic:async input=>{targets.push(input.wabaId);return {submitted:true,row:{id:targets.length,name:'TESTONLY shared'}};}}:assert.fail(name),
  });
  const res=response();await create({query:{},userData:{userId:76},body:{clinic_id:1,display_name:'TESTONLY',body_text:'TESTONLY test'}},res);
  assert.equal(res.statusCode,201);assert.deepEqual(targets,['101','102']);assert.equal(res.body.submitted,true);
});
test('native catalog provisioning checkpoints before POST, never repeats unknown result, continues other names and resumes only proven not-started work',async()=>{
  const rows=[],events=[],templates=[{id:1,name:'TESTONLY_a'},{id:2,name:'TESTONLY_b'}];let calls=0,failJob=false;
  const create=sourceFunction('../../services/whatsappTemplates.service','createTemplatesFromCatalogWithLease',{
    CATALOG_SUBMISSION_UNCONFIRMED:'unknown',CATALOG_SUBMISSION_NOT_STARTED:'not_started',
    WHATSAPP_TEMPLATE_STATUS:{LOCAL_PENDING:'PENDING_LOCAL',PENDING:'PENDING',REJECTED:'REJECTED'},
    resolveDisciplines:async()=>[],selectCatalogTemplatesByDisciplines:async()=>templates,
    resolveTargetClinicIdsForTemplateProvisioning:async()=>[1],loadTemplateFamilyRows:async({template})=>rows.filter(r=>r.id===template.id),
    findSameContractRemoteTemplate:({familyRows})=>familyRows.find(r=>r.metaTemplateId),
    findPreparedCatalogSubmission:({familyRows})=>familyRows.find(r=>['unknown','not_started'].includes(r.rejection_reason)),
    getCatalogTechnicalFamilyName:t=>t.name,getCatalogTemplateLanguage:()=> 'es',resolveNextTechnicalTemplateName:n=>n+'_v2',
    prepareTemplateImageHeaderForMeta:async({template})=>({template}),buildTemplateForTechnicalName:(t,n)=>({...t,name:n}),getImageHeaderSampleIssue:()=>null,
    upsertConnectedTemplateForWaba:async({template,technicalName,rejectionReason,metaTemplateId})=>{
      let row=rows.find(r=>r.id===template.id);if(!row){row={id:template.id,catalog_template_id:template.id};rows.push(row);}
      Object.assign(row,{name:technicalName,rejection_reason:rejectionReason,metaTemplateId});events.push(rejectionReason||'accepted');
    },
    enqueueSyncTemplatesJob:async()=>{if(failJob)throw Error('TESTONLY job failed');events.push('job');},
    createTemplateInMeta:async({template})=>{calls++;assert.deepEqual(events.slice(-3),['not_started','job','unknown']);
      if(template.id===1)throw Object.assign(Error('timeout'),{code:'provider_timeout'});return {id:'TESTONLY_meta'};},
    upsertClinicOverrideTemplateForClinic:async()=>{},mapRemoteStatusToLocalStatus:v=>v,
    templateSyncState:{blockedCode:()=>null},isRetryableMetaError:()=>true,
  });
  const input={wabaId:'101',clinicId:1,assignmentScope:'clinic',asset:{}};
  const first=await create(input);assert.equal(first.submitted,1);assert.equal(first.localPending,1);assert.equal(calls,2);
  const retry=await create(input);assert.equal(retry.submitted,0);assert.equal(calls,2);
  rows[0].rejection_reason='not_started';failJob=true;await assert.rejects(create({...input,catalogTemplateIds:[1]}),/job failed/);assert.equal(calls,2);
  failJob=false;await create({...input,catalogTemplateIds:[1]});assert.equal(calls,3);assert.equal(rows[0].name,'TESTONLY_a');
});
test('account propagation pins ordinary catalog submissions, never repeats an uncertain POST and reconciles its original remote identity',async()=>{
  const rows=[],events=[];let calls=0,remoteFound=false,discovered=null;
  const template={id:20,name:'TESTONLY_appointment',is_active:true,is_generic:true};
  const propagate=sourceFunction('../../services/whatsappTemplates.service','propagateCatalogTemplateToAllClinics',{
    getCatalogTemplateById:async()=>template,Op:{in:Symbol('in')},
    Clinica:{findAll:async()=>[{id_clinica:1,configuracion:{}}]},
    normalizeDisciplines:()=>[],templateAppliesToDisciplines:()=>true,getCatalogTechnicalFamilyName:()=>template.name,
    getCatalogTemplateLanguage:()=> 'es',cleanString:v=>String(v||'').trim(),
    syncTemplatesForWaba:async()=>{if(remoteFound)Object.assign(rows[0],{meta_template_id:'TESTONLY_meta',status:'APPROVED'});},
    loadTemplateFamilyRows:async()=>rows,findSameContractRemoteTemplate:({familyRows})=>familyRows.find(r=>r.meta_template_id),
    findReconciledCatalogTemplate:()=>discovered,
    findPreparedCatalogSubmission:({familyRows})=>familyRows.find(r=>['unknown','not_started'].includes(r.rejection_reason)),
    CATALOG_SUBMISSION_NOT_STARTED:'not_started',CATALOG_SUBMISSION_UNCONFIRMED:'unknown',
    resolveNextTechnicalTemplateName:n=>n+'_v2',buildTemplateForTechnicalName:(t,name)=>({...t,name}),
    prepareTemplateImageHeaderForMeta:async({template})=>({template}),getImageHeaderSampleIssue:()=>null,
    WHATSAPP_TEMPLATE_STATUS:{LOCAL_PENDING:'PENDING_LOCAL'},DEFAULT_PROPAGATE_RESYNC_DELAY_MINUTES:12,
    upsertConnectedTemplateForWaba:async input=>{
      let row=rows.find(r=>r.name===input.technicalName);if(!row){row={name:input.technicalName};rows.push(row);}
      Object.assign(row,{rejection_reason:input.rejectionReason,meta_template_id:input.metaTemplateId,status:input.status});
      events.push(input.rejectionReason);
    },
    enqueueSyncTemplatesJob:async()=>{events.push('sync');},
    createTemplateInMeta:async()=>{calls++;assert.deepEqual(events.slice(-3),['not_started','sync','unknown']);
      throw Object.assign(Error('TESTONLY timeout'),{code:'provider_timeout'});},
    isDuplicateTemplateNameError:()=>false,templateSyncState:{blockedCode:()=>null},
    isRetryableMetaError:e=>e.retryable||e.code==='provider_timeout',
    upsertClinicOverrideTemplateForClinic:async()=>({action:'updated',row:{id:100}}),
    mapRemoteStatusToLocalStatus:v=>v,recomposeAutomationsUsingTemplate:async()=>({}),
    isReviewRequestTemplateFamily:()=>false,
    require:name=>{assert.equal(name,'./whatsapp.service');return {getClinicConfig:async()=>({wabaId:'101',authorizedBroker:true})};},
  });
  const input={templateCatalogId:20,clinicIds:[1],wabaIds:['101'],updateCatalogPropagationState:false,enqueueFollowupSync:false,
    logger:{info(){},warn(){},error(){}}};
  await assert.rejects(propagate(input),/timeout/);assert.equal(calls,1);const name=rows[0].name;
  await assert.rejects(propagate(input),/catalog_submission_unconfirmed/);assert.equal(calls,1);assert.equal(rows[0].name,name);
  remoteFound=true;const recovered=await propagate(input);assert.equal(recovered.errors.length,0);assert.equal(recovered.created_in_meta,0);
  assert.equal(calls,1);assert.equal(rows[0].meta_template_id,'TESTONLY_meta');
  rows.length=0;remoteFound=false;
  discovered={name:'TESTONLY_appointment_v9',meta_template_id:'TESTONLY_prior_unknown',status:'APPROVED'};
  const listed=await propagate(input);assert.equal(listed.recovered_from_remote_list,1);assert.equal(calls,1);
  assert.equal(rows[0].meta_template_id,'TESTONLY_prior_unknown');
});
