'use strict';require('./fixtures/security_offline_runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),S=require('sequelize');
const H=require('../../services/businessProfileHistoryScope.service'),C=require('../../services/businessProfileAssociation.contract');
const Owner=require('../../../services/integrations-broker/src/google-business-profile-enrollment-contract');
const {loadDiscoverySource}=require('./fixtures/business_profile_discovery.fixture');
const {prepareValidatedReportSnapshot,digest}=require('../../lib/validated-report-snapshot');
function fixture(shared=false){
 const state={scope:{scope:'group',groupId:28,clinicIds:shared?[1,71]:[1,70],isAll:false,isValid:true},roles:new Map([[1,'agencia'],[70,shared?null:'agencia'],[71,'agencia']]),effective:new Map([[1,[16]],[70,[70]],[71,shared?[70]:[]]]),cache:new Map(),perClinicReads:[],projectionDestinations:[],metricScopes:[],duringRead:null,afterCache:null};
 const mapping={id:70,clinica_id:70,google_connection_id:23,location_id:'locations/456',is_active:true,broker_read_connection_ref:'connection:test',broker_read_asset_ref:'gbp:123:456'},source={...mapping,id:2,clinica_id:1,is_active:false},legacy={...mapping,id:16,clinica_id:1,location_id:'locations/111',broker_read_asset_ref:'gbp:123:111'};
 const generationId='20000000-0000-4000-8000-000000000002',attemptId='30000000-0000-4000-8000-000000000003';
 const proof={descriptorId:'40000000-0000-4000-8000-000000000004',sourceTenantRef:'clinic:1',sourceConnectionRef:'connection:test',sourceScopeRef:'gbp-enroll:clinic:1',sourceAssetRef:'gbp:123:456',retirementEnrollmentId:'50000000-0000-4000-8000-000000000005',retirementDigest:'a'.repeat(64)};
 const predecessor={mappingId:2,clinicId:1,groupId:28,assetRef:'gbp:123:456',connectionRef:'connection:test'};
 const generation={generation_id:generationId,mapping_id:70,external_location_id:'456',clinica_id:70,google_connection_id:23,connection_ref:'connection:test',asset_ref:'gbp:123:456',scope_ref:'gbp-enroll:clinic:70',previous_asset_ref:null,state:'active',association_attempt_id:attemptId,source_fingerprint:'b'.repeat(64),predecessor:[predecessor],reassociation:proof};
 generation.proof_digest=Owner.reassociationDigest(proof,{tenantRef:'clinic:70',connectionRef:generation.connection_ref,assetRef:generation.scope_ref,payload:{enrollmentId:attemptId,accountId:'123',locationId:'456',previousAssetRef:null,clinicCount:1,clinicSetDigest:C.hash([70]),reassociation:proof}});
 const locations=new Map([[16,legacy],[70,mapping],[2,source]]);
 const access=async({clinicIds})=>clinicIds.every(id=>['agencia','personaldeclinica'].includes(state.roles.get(Number(id))));
 const idList=where=>{const ids=where?.id;return ids?.[S.Op.in]||[ids].filter(v=>v!=null);};
 const model={Sequelize:S,sequelize:{transaction:async fn=>fn({LOCK:{UPDATE:true}})},Clinica:{findByPk:async id=>({id_clinica:Number(id),grupoClinicaId:28})},UsuarioClinica:{findAll:async options=>{const id=Number(options.where.id_clinica),role=state.roles.get(id);return role?[{id_clinica:id,rol_clinica:role,estado_invitacion:'aceptada'}]:[];}},
  ClinicBusinessLocation:{findByPk:async id=>locations.get(Number(id)),findAll:async({where})=>idList(where).map(id=>locations.get(Number(id))).filter(r=>r?.is_active),findOne:async()=>mapping,count:async()=>2},
  BusinessProfileBrokerRevocation:{findByPk:async()=>null},BusinessProfileBrokerBinding:{findByPk:async id=>id==='111'?{external_location_id:'111',state:'active',clinica_id:1,google_connection_id:23,connection_ref:'connection:test',asset_ref:'gbp:123:111',current_generation_id:null}:{external_location_id:'456',state:'retired',current_generation_id:generationId}},BusinessProfileBrokerBindingGeneration:{findByPk:async()=>generation},BusinessProfileAssociationRequest:{findByPk:async()=>({state:'active',target_mapping_id:70,target_snapshot:{generationId,predecessors:[predecessor]}})},
  BusinessProfileDailyMetric:{findAll:async({where})=>{const clause=where.business_location_id,ids=(clause?.[S.Op.in]||[clause]).map(Number);state.metricScopes.push(ids);await state.duringRead?.();return [{business_location_id:16,date:'2026-11-12',metric_type:'CALL_CLICKS',value:1},{business_location_id:70,date:'2026-11-12',metric_type:'CALL_CLICKS',value:2},{business_location_id:2,date:'2026-11-12',metric_type:'CALL_CLICKS',value:100}].filter(r=>ids.includes(r.business_location_id));}},BusinessProfileReview:{findOne:async()=>({}),count:async()=>0}};
 const inventory=ids=>({scope:{clinic_ids:state.scope.clinicIds},google:{available_assets:{business_profile:ids.map(id=>({mapping_id:id,clinic_id:locations.get(id).clinica_id,connection_id:23}))}}});
 const resolver=async input=>{if(input.clinicIdRaw!=null){const id=Number(input.clinicIdRaw);state.perClinicReads.push(id);return inventory(state.effective.get(id)||[]);}return inventory([16,70]);};
 const cache={readOrGenerate:async({identity,generate})=>{if(!state.cache.has(identity.cache_key))state.cache.set(identity.cache_key,await generate());const value=state.cache.get(identity.cache_key);await state.afterCache?.();return value;}};
 let controller;
 controller=loadDiscoverySource('controllers/marketingReports.controller.js',{sequelize:S,'../../models':model,'../services/effectiveMarketingAssets.service':{resolveEffectiveMarketingAssetInventory:resolver},'../services/businessProfileHistoryScope.service':{...H,createHistoryProjection:async args=>{state.projectionDestinations.push({head:args.locations[0].id,clinicId:args.clinicId});return H.createHistoryProjection({...args,permission:access});}},
  '../services/businessProfileLocal.service':{METRIC_DEFINITIONS:{profile_views:{preferred:['CALL_CLICKS'],fallback:[]}},collapseMetricRows:r=>r,metricValueByDate:r=>r.map(v=>({value:v.value}))},
  '../lib/validated-report-snapshot':{prepareValidatedReportSnapshot:input=>prepareValidatedReportSnapshot({...input,generate:async()=>({success:true,businessProfile:(await controller.__testing.aggregateBusinessProfile(state.scope,{startLabel:'2026-11-01',endLabel:'2026-11-13',start:new Date('2026-11-01'),endExclusive:new Date('2026-11-14')},await controller.__testing.resolveReportMarketingState(state.scope),9)).metrics})})},
  '../services/marketingReportOverviewCache.service':{buildOverviewCacheIdentity:input=>({cache_key:digest(input)}),overviewCache:cache},'../lib/clinicScope':{resolveClinicScope:async()=>state.scope},'../lib/marketingScopeAccess':{hasMarketingClinicScopeAccess:access},'../lib/role-helpers':{isGlobalAdmin:()=>false},'../lib/searchConsoleReadSource':require('../../lib/searchConsoleReadSource')},{env:{SC_ANALYTICS_READ_ENABLED:'false'}});
 const request=async()=>{const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};await controller.getOverview({query:{clinicId:'group:28',startDate:'2026-11-01',endDate:'2026-11-13'},userData:{userId:9}},res);return res;};
 return {state,request,model,access,mapping,legacy,inventory,resolver};
}
test('group report checks independent owner 70, denies mid-await READ70 loss with 403 and no cache payload; filtered clinic1 keeps only16',async()=>{
 const f=fixture();f.state.duringRead=async()=>{f.state.roles.set(70,null);};const denied=await f.request();assert.equal(denied.statusCode,403);assert.equal(denied.body.businessProfile,undefined);assert.equal(f.state.cache.size,0);assert(f.state.projectionDestinations.some(p=>p.head===70&&p.clinicId===70));
 f.state.duringRead=null;f.state.scope={scope:'clinic',clinicIds:[1],isAll:false,isValid:true};const filtered=await f.request();assert.equal(filtered.statusCode,200);assert.deepEqual(f.state.metricScopes.at(-1),[16]);assert.equal(filtered.body.businessProfile.views,1);
});
test('cached group response cannot disclose owner70 after its READ is revoked, while preserving unrelated valid cache data',async()=>{
 const f=fixture();assert.equal((await f.request()).statusCode,200);assert.deepEqual([...f.state.metricScopes.at(-1)].sort((a,b)=>a-b),[2,16,70]);const stored=[...f.state.cache.values()][0];f.state.afterCache=async()=>{f.state.roles.set(70,null);};const denied=await f.request();assert.equal(denied.statusCode,403);assert.equal(denied.body.businessProfile,undefined);assert.equal([...f.state.cache.values()][0],stored);
});
test('shared owner outside group scope uses actual destination71 instead of first clinic1 and denies READ71 loss',async()=>{
 const f=fixture(true);assert.equal((await f.request()).statusCode,200);assert(f.state.projectionDestinations.some(p=>p.head===70&&p.clinicId===71));assert(!f.state.projectionDestinations.some(p=>p.head===70&&p.clinicId===1));f.state.afterCache=async()=>{f.state.roles.set(71,null);};const denied=await f.request();assert.equal(denied.statusCode,403);assert.equal(denied.body.businessProfile,undefined);
});
test('group-level presence or common group membership never replaces a per-clinic sharing relationship',async()=>{
 const f=fixture(true);f.state.effective.set(71,[]);const denied=await f.request();assert.equal(denied.statusCode,403);assert.equal(denied.body.businessProfile,undefined);assert.equal(f.state.cache.size,0);
});
module.exports={fixture};

function activityFixture(shared=false){
 const f=fixture(shared),caches=[],privateScopes=[];f.state.activityAfterCache=null;f.state.activityDuringQuery=null;f.state.sqlCalls=0;
 const destination=shared?71:70;
 f.model.sequelize.query=async(sql,options)=>{
  f.state.sqlCalls++;const r=options.replacements;
  assert.deepEqual(Array.from(r.clinicIds),shared?[1,71]:[1,70]);assert.deepEqual(Array.from(r.locationIds),[16,70]);privateScopes.push(Array.from(r.locationIds));
  await f.state.activityDuringQuery?.();
  if(sql.includes("SELECT 'google_reviews_total' metric")){
    assert(sql.includes('WHEN 2 THEN '+destination),'provider predecessor must render under the authorized public destination');
    assert.deepEqual(Array.from(r.providerLocationIds).sort((a,b)=>a-b),[2,16,70]);
    return [{metric:'google_reviews_total',at_utc:'2026-11-12T12:00:00Z',total:1,clinic_id:destination}];
  }
  if(sql.includes('missing_total'))return [{}];return [];
 };
 const activity=loadDiscoverySource('services/reviewActivityReport.service.js',{
  sequelize:S,'../lib/availability-calendar':require('../../lib/availability-calendar'),'../lib/review-response-heatmaps':require('../../lib/review-response-heatmaps'),
  './businessProfileHistoryScope.service':{...H,createHistoryProjection:args=>{f.state.projectionDestinations.push({head:args.locations[0].id,clinicId:args.clinicId});return H.createHistoryProjection({...args,permission:f.access});}},
  './reviewScoreTrend.service':{readScoreTrends:async()=>[]},'../lib/report-read-cache':{createReportReadCache:()=>{const cache=require('../../lib/report-read-cache').createReportReadCache(),read=cache.read;cache.read=async(...args)=>{const result=await read(...args);await f.state.activityAfterCache?.();return result;};caches.push(cache);return cache;}},
 });
 const options={clinicIds:f.state.scope.clinicIds,locationIds:[16,70],locationOwners:{16:[1],70:[destination]},userId:9,period:'30d',now:new Date('2026-11-13T12:00:00Z'),resolveEffectiveMappingIdsForClinic:async id=>{f.state.perClinicReads.push(id);return f.state.effective.get(id)||[];}};
 return {...f,caches,privateScopes,read:()=>activity.readReport(f.model,options),destination};
}
for(const shared of [false,true])test('Activity report '+(shared?'shared destination71':'independent owner70')+' revalidates actual READ and never expands private CRM scope',async()=>{
 const f=activityFixture(shared);const positive=await f.read();assert.equal(positive.totals.google_reviews_total,1);assert(positive.by_clinic.every(r=>r.clinic_id===f.destination));assert(f.state.projectionDestinations.some(p=>p.head===70&&p.clinicId===f.destination));assert.equal(f.caches[0].size(),1);
 f.state.activityAfterCache=async()=>{f.state.roles.set(f.destination,null);};await assert.rejects(f.read(),error=>error.code==='scope_denied'&&error.status===403);
 const failed=activityFixture(shared);failed.state.activityDuringQuery=async()=>{failed.state.roles.set(failed.destination,null);};await assert.rejects(failed.read(),error=>error.code==='scope_denied'&&error.status===403);assert.equal(failed.caches[0].size(),0,'crossed-authority generation must not populate cache');
});
test('Activity shared owner outside scope requires per-clinic effective sharing, not group-level membership',async()=>{
 const f=activityFixture(true);f.state.effective.set(71,[]);await assert.rejects(f.read(),error=>error.code==='scope_denied'&&error.status===403);assert.equal(f.state.sqlCalls,0);assert.equal(f.caches.length,0);
});
