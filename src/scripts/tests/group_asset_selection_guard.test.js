'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
const {Op}=require('sequelize');
const guard=require('../../services/groupAssetSelectionGuard.service');
const clone=value=>structuredClone(value);
function matches(row,where={}) {
  return Reflect.ownKeys(where).every(key=>key===Op.or?where[key].some(v=>matches(row,v)):key===Op.and?where[key].every(v=>matches(row,v)):
    where[key]&&typeof where[key]==='object'&&!Array.isArray(where[key])?Reflect.ownKeys(where[key]).every(op=>op===Op.in?where[key][op].includes(row[key]):op===Op.notIn?!where[key][op].includes(row[key]):op===Op.ne?row[key]!==where[key][op]:false):row[key]===where[key]);
}
function fixture() {
  const state={GrupoClinica:[{id_grupo:9,nombre_grupo:'Grupo ficticio',ads_assignment_mode:'manual',facebook_assignment_mode:'clinic',instagram_assignment_mode:'clinic',search_console_assignment_mode:'clinic',analytics_assignment_mode:'clinic',business_profile_assignment_mode:'clinic'}],
    Clinica:[{id_clinica:71,grupoClinicaId:9,nombre_clinica:'Sede ficticia A'},{id_clinica:72,grupoClinicaId:9,nombre_clinica:'Sede ficticia B'}],
    ClinicWebAsset:[],ClinicAnalyticsProperty:[],ClinicBusinessLocation:[],ClinicGoogleAdsAccount:[],ClinicMetaAsset:[],GroupAssetClinicAssignment:[],IntakeConfig:[],
    GoogleConnection:[{id:81,googleUserId:'subject-google',credentials_external:1}],GoogleOAuthBrokerBinding:[],
    GoogleConnectionAssignment:[{id:1,scopeKey:'group:9',assignmentScope:'group',clinicaId:null,grupoClinicaId:9,googleConnectionId:81,status:'active'}],
    SearchConsoleBrokerBinding:[],AnalyticsBrokerBinding:[],BusinessProfileBrokerBinding:[],BusinessProfileBrokerBindingGeneration:[],GoogleAdsBrokerBinding:[],GooglePropertyBrokerRevocation:[],BusinessProfileBrokerRevocation:[],GoogleAdsBrokerRevocation:[],
    MetaConnection:[{id:82,metaUserId:'12345',broker_app_id:'98765',credentials_external:1,credentials_absent:1}],MetaScopeBlock:[],
    MetaConnectionAssignment:[{id:2,scopeKey:'group:9',assignmentScope:'group',clinicaId:null,grupoClinicaId:9,metaConnectionId:82,status:'active',updated_at:null}],
    MetaMarketingBrokerBinding:[],MetaMarketingBrokerRevocation:[]};
  const calls=[],writes=[],models={},stats={committed:0,rolledBack:0};
  let hook=null,beforeTransaction=null;
  const keyFor=name=>name==='GrupoClinica'?'id_grupo':name==='Clinica'?'id_clinica':name==='BusinessProfileBrokerBindingGeneration'?'generation_id':name==='BusinessProfileBrokerBinding'||name==='BusinessProfileBrokerRevocation'?'external_location_id':'id';
  const project=(row,options={})=>{
    let value=options.attributes?Object.fromEntries(options.attributes.map(v=>Array.isArray(v)?[v[1],typeof v[0]==='string'?row[v[0]]??null:row[v[1]]??(v[1]==='credentials_absent'?1:null)]:[v,row[v]??null])):clone(row);
    return options.raw?value:{...value,get:()=>clone(value)};
  };
  for(const name of Object.keys(state))models[name]={
    async findAll(options={}) {calls.push({name,options});return state[name].filter(row=>matches(row,options.where)).slice(0,options.limit??Infinity).map(row=>project(row,options));},
    async findOne(options={}) {return (await this.findAll(options))[0]||null;},
    async findByPk(id,options={}) {const row=state[name].find(v=>v[keyFor(name)]===id);if(!row)return null;
      if(name==='GrupoClinica'&&options.include)return {get:()=>({...clone(row),clinicas:clone(state.Clinica.filter(v=>v.grupoClinicaId===id))})};
      return project(row,options);},
    async update(patch,options={}) {writes.push({name,patch:clone(patch),where:options.where});let n=0;for(const row of state[name])if(matches(row,options.where)){Object.assign(row,clone(patch));n++;}return [n];},
    async destroy(options={}) {writes.push({name,destroy:true});state[name]=state[name].filter(row=>!matches(row,options.where));},
    async bulkCreate(rows,options={}) {writes.push({name,rows:clone(rows)});state[name].push(...clone(rows));if(hook)await hook(name);},
  };
  models.sequelize={async transaction(){if(beforeTransaction)await beforeTransaction();const before=clone(state);return {LOCK:{UPDATE:'UPDATE'},finished:false,
    async commit(){this.finished='commit';stats.committed++;},async rollback(){for(const key of Object.keys(state))state[key]=before[key];this.finished='rollback';stats.rolledBack++;}};}};
  const filename=path.resolve(__dirname,'../../services/groupAssets.service.js'),native=createRequire(filename),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:id=>id==='../../models'?models:
    id==='./clinicWebRuntimeMembership.service'?{assertClinicWordpressMembershipChangeSafe:async()=>{},assertClinicWebRuntimeGroupChangeSafe:async()=>{}}:native(id),console,process,Date,Map,Set,Number,JSON},{filename});
  const env=Object.fromEntries(['GOOGLE_SEARCH_CONSOLE_BROKER_ENABLED','GOOGLE_ANALYTICS_BROKER_ENABLED','GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED','GOOGLE_ADS_BROKER_ENABLED','META_MARKETING_BROKER_ENABLED'].map(v=>[v,'true']));
  return {state,models,calls,writes,stats,service:module.exports,env,setHook:value=>hook=value,setBeforeTransaction:value=>beforeTransaction=value};
}
function google(f,kind='searchConsole',id=91) {
  const base={id,clinicaId:71,googleConnectionId:81,isActive:true,broker_read_connection_ref:'google-connection',broker_read_asset_ref:null};
  if(kind==='searchConsole') {
    const r=require('../../../services/integrations-broker/src/google-search-console-contract').site('https://synthetic.example/');
    f.state.ClinicWebAsset.push({...base,siteUrl:r.siteUrl,broker_read_asset_ref:r.assetRef});
    f.state.SearchConsoleBrokerBinding.push({site_hash:r.siteHash,site_url:r.siteUrl,mapping_id:id,connection_ref:base.broker_read_connection_ref,asset_ref:r.assetRef,clinica_id:71,google_connection_id:81,google_user_id:'subject-google',state:'active'});
  } else if(kind==='analytics') {
    f.state.ClinicAnalyticsProperty.push({...base,propertyName:'properties/12345',broker_read_asset_ref:'ga4:12345'});
    f.state.AnalyticsBrokerBinding.push({property_name:'properties/12345',mapping_id:id,connection_ref:base.broker_read_connection_ref,asset_ref:'ga4:12345',clinica_id:71,google_connection_id:81,google_user_id:'subject-google',state:'active'});
  } else if(kind==='businessProfile') {
    f.state.ClinicBusinessLocation.push({id,clinica_id:71,google_connection_id:81,is_active:true,location_id:'locations/12345',broker_read_connection_ref:base.broker_read_connection_ref,broker_read_asset_ref:'gbp:123:12345'});
    f.state.BusinessProfileBrokerBinding.push({external_location_id:'12345',connection_ref:base.broker_read_connection_ref,asset_ref:'gbp:123:12345',clinica_id:71,google_connection_id:81,state:'active'});
    f.state.GoogleOAuthBrokerBinding.push({google_user_id:'subject-google',cohort:'business_profile',google_connection_id:81,connection_ref:base.broker_read_connection_ref,asset_ref:'gbp:123:12345',clinica_id:71,scope_key:'connection:81',policy_version:'google-oauth-cohorts-v1',confirmed_at:new Date('2026-01-01')});
  } else {
    f.state.ClinicGoogleAdsAccount.push({...base,customerId:'1234567890',broker_read_asset_ref:'ads:1234567890',assignmentScope:'group',clinicaId:null,grupoClinicaId:9,loginCustomerId:null,managerCustomerId:null});
    f.state.GoogleAdsBrokerBinding.push({customer_id:'1234567890',mapping_id:id,google_connection_id:81,google_user_id:'subject-google',connection_ref:base.broker_read_connection_ref,asset_ref:'ads:1234567890',scope_key:'group:9',tenant_clinic_id:71,login_customer_id:null,state:'active'});
  }
  return id;
}
function meta(f,kind='facebook',id=92) {
  const type={facebook:'facebook_page',instagram:'instagram_business',metaAds:'ad_account'}[kind],asset=String(id+1000);
  f.state.ClinicMetaAsset.push({id,metaConnectionId:82,assetType:type,metaAssetId:type==='ad_account'?'act_'+asset:asset,assignmentScope:'group',clinicaId:null,grupoClinicaId:9,isActive:true,credentials_absent:1});
  f.state.MetaMarketingBrokerBinding.push({mapping_id:id,enrollment_id:null,asset_ref:'meta-'+type+':'+asset,meta_connection_id:82,meta_user_id:'12345',app_id:'98765',connection_ref:'meta-connection',scope_key:'group:9',tenant_clinic_id:71,parent_page_id:type==='instagram_business'?'1092':null,state:'active'});
  return id;
}
function payload(kind,id,mode='clinic') {
  const section=mode==='group'?{mode,primaryAssetId:id,primaryAccountId:id}:{mode,clinicAssignments:{71:id,72:id}};
  return ['metaAds','googleAds'].includes(kind)?{adsAccounts:{[kind==='metaAds'?'meta':'google']:section}}:
    { [['facebook','instagram'].includes(kind)?'meta':'google']:{[kind]:section} };
}
async function withEnv(f,fn) {const before={};for(const [key,value]of Object.entries(f.env)){before[key]=process.env[key];process.env[key]=value;}try{return await fn();}finally{for(const key of Object.keys(f.env))before[key]===undefined?delete process.env[key]:process.env[key]=before[key];}}
const expectConflict=(promise,code)=>assert.rejects(promise,e=>e.status===409&&e.code===code&&!e.message.includes('SENTINEL'));

test('all seven kinds reject inactive IDs in clinic and group mode before changing any assignment',async()=>{
 for(const kind of Object.keys(guard.KINDS))for(const mode of ['clinic','group']) {
  const f=fixture(),id=['facebook','instagram','metaAds'].includes(kind)?meta(f,kind):google(f,kind);
  const spec=guard.KINDS[kind];f.state[spec.model][0][spec.active]=false;
  f.state.GroupAssetClinicAssignment.push({grupoClinicaId:9,assetType:'unrelated',assetId:999,clinicaId:72});
  const before=clone(f.state);
  await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,payload(kind,id,mode)),'group_asset_reconnection_required'));
  assert.deepEqual(f.state,before);assert.equal(f.stats.committed,0);assert.equal(f.stats.rolledBack,1);assert.equal(f.writes.length,0);
 }
});
test('mixed valid Google and retired Meta selection rolls back the entire multi-clinic group request',async()=>{
 const f=fixture(),gid=google(f),mid=meta(f);f.state.MetaMarketingBrokerBinding[0].state='blocked';
 const before=clone(f.state),request={nombre_grupo:'Must not persist',...payload('searchConsole',gid),...payload('facebook',mid)};
 await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,request),'group_asset_reconnection_required'));
 assert.deepEqual(f.state,before);assert.equal(f.writes.length,0);assert.equal(f.stats.rolledBack,1);
});
test('an unexpected Meta section cannot shadow the Google asset which the writer will actually assign',async()=>{
 for(const kind of ['searchConsole','analytics','businessProfile']){
  const f=fixture(),inactiveId=google(f,kind,91),activeId=google(f,kind,92),spec=guard.KINDS[kind];
  f.state[spec.model].find(row=>row.id===inactiveId)[spec.active]=false;
  const request=payload(kind,inactiveId,'group');request.meta={[kind]:{mode:'group',primaryAssetId:activeId}};
  const before=clone(f.state);
  await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,request),'group_asset_reconnection_required'));
  assert.deepEqual(f.state,before);assert.equal(f.writes.length,0);
 }
});
test('managed Google property sharing preserves source, unselected mappings and grants; removing shares changes no provider activation',async()=>{
 const f=fixture(),id=google(f);f.state.ClinicWebAsset.push({...clone(f.state.ClinicWebAsset[0]),id:99,isActive:true,siteUrl:'https://other.example/'});
 const originals=clone({m:f.state.ClinicWebAsset,b:f.state.SearchConsoleBrokerBinding,g:f.state.GoogleConnectionAssignment});
 await withEnv(f,()=>f.service.updateGroupConfig(9,payload('searchConsole',id)));
 assert.equal(f.state.GroupAssetClinicAssignment.length,2);assert.deepEqual(f.state.ClinicWebAsset,originals.m);assert.deepEqual(f.state.SearchConsoleBrokerBinding,originals.b);
 await withEnv(f,()=>f.service.updateGroupConfig(9,{google:{searchConsole:{mode:'clinic',clinicAssignments:{71:id,72:null}}}}));
 assert.deepEqual(f.state.GroupAssetClinicAssignment.map(v=>v.clinicaId),[71]);assert.deepEqual(f.state.ClinicWebAsset,originals.m);assert.deepEqual(f.state.GoogleConnectionAssignment,originals.g);
 assert.equal(f.writes.some(v=>v.name==='ClinicWebAsset'),false);
});
test('active Meta pages, Instagram and Ads remain owned by their registered group while sharing and choosing primary',async()=>{
 const f=fixture(),page=meta(f),ig=meta(f,'instagram',93),ad=meta(f,'metaAds',94),old=clone(f.state.ClinicMetaAsset);
 const request={meta:{...payload('facebook',page,'group').meta,...payload('instagram',ig).meta},adsAccounts:payload('metaAds',ad,'group').adsAccounts};
 await withEnv(f,()=>f.service.updateGroupConfig(9,request));
 assert.deepEqual(f.state.ClinicMetaAsset,old);assert.equal(f.writes.some(v=>v.name==='ClinicMetaAsset'),false);
 assert.equal(f.state.GrupoClinica[0].facebook_primary_asset_id,page);assert.equal(f.state.GroupAssetClinicAssignment.filter(v=>v.assetType==='meta.ad_account').length,2);
});
test('active managed Google Ads keeps exact immutable owner and still permits existing group members to use it',async()=>{
 const f=fixture(),id=google(f,'googleAds'),before=clone(f.state.ClinicGoogleAdsAccount);
 await withEnv(f,()=>f.service.updateGroupConfig(9,payload('googleAds',id,'group')));
 assert.deepEqual(f.state.ClinicGoogleAdsAccount,before);assert.equal(f.state.GroupAssetClinicAssignment.length,2);
});
test('a withdrawal of another Google Ads tuple does not withdraw an independently valid selected tuple',async()=>{
 const f=fixture(),id=google(f,'googleAds'),R=require('../../services/googleAdsRevocation.contract');
 const revocation={customer_id:'1234567890',connection_ref:'other-google-connection',asset_ref:'ads:1234567890',tenant_clinic_id:99,
  google_connection_id:999,google_user_id:'other-google-subject',login_customer_id:null,scope_key:'clinic:99',clinic_ids:'[99]',mapping_ids:'[999]',
  request_id:require('node:crypto').randomUUID(),actor_user_id:1,requested_at:new Date(),state:'confirmed'};
 revocation.tuple_hash=R.tupleHash(revocation);R.validate(revocation);f.state.GoogleAdsBrokerRevocation.push(revocation);
 const original=clone(f.state.GoogleAdsBrokerRevocation);
 await withEnv(f,()=>f.service.updateGroupConfig(9,payload('googleAds',id,'group')));
 assert.deepEqual(f.state.GoogleAdsBrokerRevocation,original);assert.equal(f.state.GroupAssetClinicAssignment.length,2);
});
test('GBP accepts only the exact active successor generation while its historical parent remains retired',async()=>{
 const f=fixture(),id=google(f,'businessProfile'),{randomUUID}=require('node:crypto'),generation=randomUUID();
 const mapping=f.state.ClinicBusinessLocation[0];mapping.clinica_id=72;
 const parent=f.state.BusinessProfileBrokerBinding[0];parent.state='retired';parent.current_generation_id=generation;
 f.state.BusinessProfileBrokerBindingGeneration.push({...clone(parent),generation_id:generation,mapping_id:id,clinica_id:72,state:'active',association_attempt_id:randomUUID(),source_fingerprint:'a'.repeat(64),scope_ref:'gbp-enroll:clinic:72'});
 const original=clone(parent);await withEnv(f,()=>f.service.updateGroupConfig(9,payload('businessProfile',id)));
 assert.deepEqual(f.state.BusinessProfileBrokerBinding[0],original);
 f.state.BusinessProfileBrokerBindingGeneration[0].mapping_id=id+1;const before=clone(f.state);
 await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,payload('businessProfile',id)),'group_asset_authority_conflict'));
 assert.deepEqual(f.state,before);
});
test('active Meta tombstone and incoherent Google binding cannot be overcome with a true mapping flag',async()=>{
 for(const provider of ['meta','google']) {
  const f=fixture(),id=provider==='meta'?meta(f):google(f);
  if(provider==='meta')f.state.MetaMarketingBrokerRevocation.push({tuple_hash:'SENTINEL_PRIVATE',asset_ref:f.state.MetaMarketingBrokerBinding[0].asset_ref});
  else f.state.SearchConsoleBrokerBinding[0].google_connection_id=999;
  const before=clone(f.state);
  await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,payload(provider==='meta'?'facebook':'searchConsole',id)),provider==='meta'?'group_asset_reconnection_required':'group_asset_authority_conflict'));
  assert.deepEqual(f.state,before);assert.equal(f.stats.rolledBack,1);
 }
});
test('all managed families reject active rows after their registry disappears',async()=>{
 for(const kind of Object.keys(guard.KINDS)) {
  const f=fixture(),id=guard.KINDS[kind].type?meta(f,kind):google(f,kind);f.state[guard.KINDS[kind].registry]=[];
  await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,payload(kind,id)),'group_asset_authority_conflict'));
  assert.equal(f.stats.committed,0);assert.equal(f.writes.length,0);
 }
});
test('a disconnected clinic override blocks sharing an otherwise active Google property inherited from group',async()=>{
 const f=fixture(),id=google(f);f.state.GoogleConnectionAssignment.push({id:3,scopeKey:'clinic:72',assignmentScope:'clinic',clinicaId:72,grupoClinicaId:null,googleConnectionId:81,status:'disconnected'});
 await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,payload('searchConsole',id)),'group_asset_authority_conflict'));
 assert.equal(f.writes.length,0);
});
test('a partial clinic key cannot bypass preflight while the writer parses it as another clinic',async()=>{
 const f=fixture(),id=google(f);f.state.ClinicWebAsset[0].isActive=false;
 const before=clone(f.state);
 await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,{google:{searchConsole:{mode:'clinic',clinicAssignments:{'71x':id}}}}),'group_asset_authority_conflict'));
 assert.deepEqual(f.state,before);assert.equal(f.writes.length,0);
});
test('asset identifiers accept only safe positive integers or canonical decimal strings before any write',async()=>{
 for(const id of [true,[91],[],{},'91e0','91.0',' 91','91 ','091','+91',0,-1,Number.MAX_SAFE_INTEGER+1]) {
  const f=fixture();google(f,'searchConsole',id===true?1:91);const before=clone(f.state);
  await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,payload('searchConsole',id)),'group_asset_authority_conflict'));
  assert.deepEqual(f.state,before);assert.equal(f.writes.length,0);assert.equal(f.stats.committed,0);
 }
 assert.equal(guard.selections(payload('searchConsole','91'),[71,72])[0].id,91);
 assert.equal(guard.selections(payload('searchConsole',91),[71,72])[0].id,91);
});
test('external credentials or a retained OAuth cohort prevent a missing registry from reopening legacy with gates off',async()=>{
 for(const provider of ['google','meta']) {
  const f=fixture(),id=provider==='google'?google(f):meta(f);
  for(const key of Object.keys(f.env))f.env[key]='false';
  if(provider==='google') {
   const binding=f.state.SearchConsoleBrokerBinding[0];f.state.SearchConsoleBrokerBinding=[];
   f.state.GoogleOAuthBrokerBinding.push({google_user_id:'subject-google',cohort:'search_console',google_connection_id:81,connection_ref:binding.connection_ref,asset_ref:binding.asset_ref,clinica_id:71,scope_key:'connection:81',policy_version:'google-oauth-cohorts-v1',confirmed_at:new Date('2026-01-01')});
   f.state.ClinicWebAsset[0].broker_read_connection_ref=null;f.state.ClinicWebAsset[0].broker_read_asset_ref=null;
  } else f.state.MetaMarketingBrokerBinding=[];
  await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,payload(provider==='google'?'searchConsole':'facebook',id)),'group_asset_authority_conflict'));
  assert.equal(f.writes.length,0);
 }
});
test('group preflight uses locking metadata projections and never hydrates credential columns',async()=>{
 const f=fixture(),id=meta(f);google(f);
 await withEnv(f,()=>f.service.updateGroupConfig(9,{...payload('facebook',id),...payload('searchConsole',91)}));
 const protectedNames=new Set(['GoogleConnection','MetaConnection','ClinicMetaAsset']);
 for(const call of f.calls.filter(v=>protectedNames.has(v.name)&&v.options.transaction)) {
  assert.equal(call.options.lock,'UPDATE');assert(Array.isArray(call.options.attributes));
  assert(!call.options.attributes.some(v=>typeof v==='string'&&['accessToken','refreshToken','pageAccessToken','waAccessToken','additionalData'].includes(v)));
 }
});
test('precommit compares original authority instead of accepting a fresh fingerprint after planned assignment writes',async()=>{
 const f=fixture(),id=google(f),before=clone(f.state);
 f.setHook(async name=>{if(name==='GroupAssetClinicAssignment')f.state.SearchConsoleBrokerBinding[0].state='blocked';});
 await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,payload('searchConsole',id)),'group_asset_authority_conflict'));
 assert.deepEqual(f.state,before);assert.equal(f.stats.rolledBack,1);assert.equal(f.stats.committed,0);assert(f.writes.length>0);
});
test('cohort exits or additions between group loading and locks reject selected and empty requests without undoing the concurrent membership',async()=>{
 for(const kind of ['searchConsole','facebook'])for(const change of ['exit','addition'])for(const empty of [false,true]) {
  const f=fixture(),id=kind==='facebook'?meta(f):google(f);let concurrent;
  f.state.GroupAssetClinicAssignment.push({grupoClinicaId:9,assetType:kind==='facebook'?'meta.facebook_page':'google.search_console',assetId:id,clinicaId:71});
  f.setBeforeTransaction(()=>{
   if(change==='exit')f.state.Clinica[1].grupoClinicaId=10;
   else f.state.Clinica.push({id_clinica:73,grupoClinicaId:9,nombre_clinica:'Sede concurrente ficticia'});
   concurrent=clone(f.state);
  });
  await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,payload(kind,empty?null:id)),'group_asset_authority_conflict'));
  assert.deepEqual(f.state,concurrent);assert.equal(f.writes.length,0);assert.equal(f.stats.committed,0);assert.equal(f.stats.rolledBack,1);
 }
});
test('precommit rechecks the exact original group cohort after planned assignment writes',async()=>{
 const f=fixture(),id=google(f),before=clone(f.state);
 f.setHook(async name=>{if(name==='GroupAssetClinicAssignment')f.state.Clinica[1].grupoClinicaId=10;});
 await withEnv(f,()=>expectConflict(f.service.updateGroupConfig(9,payload('searchConsole',id)),'group_asset_authority_conflict'));
 assert.deepEqual(f.state,before);assert.equal(f.stats.committed,0);assert.equal(f.stats.rolledBack,1);assert(f.writes.length>0);
});
test('legacy active mappings may be selected only without managed authority, but never reactivate or deactivate other mappings',async()=>{
 const f=fixture(),id=google(f);f.state.SearchConsoleBrokerBinding=[];f.state.ClinicWebAsset[0].broker_read_asset_ref=null;f.state.ClinicWebAsset[0].broker_read_connection_ref=null;
 for(const key of Object.keys(f.env))f.env[key]='false';
 f.state.ClinicWebAsset.push({...clone(f.state.ClinicWebAsset[0]),id:99,isActive:false,siteUrl:'https://retired.example/'});
 const before=clone(f.state.ClinicWebAsset);
 await withEnv(f,()=>f.service.updateGroupConfig(9,payload('searchConsole',id)));
 assert.deepEqual(f.state.ClinicWebAsset,before);assert.equal(f.state.GroupAssetClinicAssignment.length,2);
});
test('Ads matching mode changes do not rewrite registered mappings or clear their existing assignments',async()=>{
 const f=fixture();google(f,'googleAds');meta(f,'metaAds');f.state.GroupAssetClinicAssignment.push({grupoClinicaId:9,assetType:'meta.ad_account',assetId:92,clinicaId:71});
 const before=clone({g:f.state.ClinicGoogleAdsAccount,m:f.state.ClinicMetaAsset,a:f.state.GroupAssetClinicAssignment});
 await f.service.updateGroupConfig(9,{ads:{mode:'automatic'}});
 assert.deepEqual({g:f.state.ClinicGoogleAdsAccount,m:f.state.ClinicMetaAsset,a:f.state.GroupAssetClinicAssignment},before);
});
test('controller already exposes the bounded status, safe error code and message without starting background jobs on rejection',()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../../controllers/gruposclinicas.controller.js'),'utf8');
 const update=source.slice(source.indexOf('exports.updateGroup ='),source.indexOf('exports.deleteGroup ='));
 assert.match(update,/Number\(error\.status\)/);assert.match(update,/error:\s*error\?\.code/);
 assert(update.indexOf('await groupAssetsService.updateGroupConfig')<update.indexOf('enqueueUniqueJobRequest'));
});
