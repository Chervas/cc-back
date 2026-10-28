'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const ROOT=path.resolve(__dirname,'../../..');
const {Op}=require('sequelize');
const contract=require('../../lib/searchConsoleAnalyticsContract');
const denied=()=>assert.fail('No model bootstrap, SQL transport, provider or undeclared dependency is permitted');
function fixture(){
  const logs=[];const dependencies={
    sequelize:{Op},'../../models':{},
    './effectiveMarketingAssets.service':{resolveEffectiveMarketingAssetInventory:denied},
    './businessProfileLocal.service':{serializeLocation:denied},
    './marketingBulkSends.service':{getReviewRequestAutomationStatus:denied},
    './searchConsoleAnalytics.service':{isReadEnabled:()=>false,availability:denied},
    './searchConsoleBroker.service':{prepare:denied},
    '../lib/searchConsoleAnalyticsContract':contract,
  };
  const context=vm.createContext({Date,Buffer,URL,process:{env:{}},console:{log:(...a)=>logs.push(a),error:denied},
    setTimeout:(callback,ms)=>{assert.equal(ms,5000);return setTimeout(callback,10);},clearTimeout});
  function load(filename,source,deps){
    const module={exports:{}};
    const fn=new vm.Script('(function(module,exports,require,__filename,__dirname){\n'+source+'\n})',{filename}).runInContext(context,{timeout:1000});
    fn(module,module.exports,name=>Object.hasOwn(deps,name)?deps[name]:denied(),filename,path.dirname(filename));return module.exports;
  }
  const sourcePath=path.join(ROOT,'src/services/marketingObjectiveStatus.service.js');
  const service=load(sourcePath,fs.readFileSync(sourcePath,'utf8'),dependencies);
  const oldPath=path.join(ROOT,'src/scripts/tests/marketing_objective_status.test.js');
  const original=fs.readFileSync(oldPath,'utf8');
  const tail=original.lastIndexOf('main().catch(');assert(tail>0);
  const old=load(oldPath,original.slice(0,tail)+'module.exports={main,fullDependencies};',{
    'node:assert/strict':assert,'../../services/marketingObjectiveStatus.service':service,
  });
  function compact(){
    const deps=old.fullDependencies();const originalInventory=deps.resolveInventory;
    deps.resolveInventory=async args=>{
      assert.equal(args.clinicIdRaw,66);assert.equal(args.assignmentScopeRaw,'clinic');
      const inventory=await originalInventory(args);
      inventory.google.available_assets.search_console=[{mapping_id:8,clinic_id:66,connection_id:81,verified:true,site_url:'sc-domain:example.invalid',assignment_origin:'clinic'}];
      return inventory;
    };
    deps.isSearchConsoleReadEnabled=()=>true;
    deps.WebScDailyAgg={findOne:denied};deps.WebScQueryDaily={findOne:denied};
    deps.prepareSearchConsoleMapping=async mapping=>{
      assert(Number.isSafeInteger(mapping.id)&&mapping.id>0);assert(Number.isSafeInteger(mapping.clinicaId)&&mapping.clinicaId>0);
      assert(Number.isSafeInteger(mapping.googleConnectionId)&&mapping.googleConnectionId>0);assert.equal(mapping.isActive,true);
      return null; // the established reader also allows genuinely unmarked legacy mappings
    };
    deps.searchConsoleAvailability=async({siteUrls})=>({properties:siteUrls.map(siteUrl=>({siteUrl,totalsThrough:'2026-08-22',detailThrough:null}))});
    return deps;
  }
  const scope={scopeType:'clinic',scopeId:66,clinicIds:[66]};
  const run=deps=>service.getMarketingObjectiveStatus(scope,deps);
  const seo=result=>result.families.find(x=>x.id==='new_patients').subobjectives.find(x=>x.id==='seo_ai');
  function unknown(result){const v=seo(result);assert.equal(v.state,'unknown');assert.equal(v.eligible_points,0);assert.equal(v.earned_points,null);
    assert.equal(v.blockers[0].code,'search_console_data_unavailable');assert.equal(result.families.find(x=>x.id==='reputation').score,100);}
  return{service,old,compact,run,seo,unknown,load,logs};
}
test('all ten original objective regression groups run unchanged with READfalse and no models bootstrap',async()=>{
  const f=fixture();await f.old.main();assert.equal(f.logs[0][0],'marketing_objective_status.test.js: OK');
});
test('READfalse preserves both legacy SELECT shapes and aggregate-before-detail date precedence',async()=>{
  const f=fixture();const deps=f.old.fullDependencies();const calls=[];
  deps.searchConsoleAvailability=denied;
  deps.WebScDailyAgg={findOne:async options=>{calls.push(options);return{date:'2026-08-22'};}};
  deps.WebScQueryDaily={findOne:async options=>{calls.push(options);return{date:'2026-08-23'};}};
  const result=await f.run(deps);assert.equal(calls.length,2);
  assert(calls.some(x=>x.attributes.includes('query')));assert(calls.some(x=>x.attributes.includes('queries_top10')));
  assert.equal(f.seo(result).evidence.latest_search_console_date,'2026-08-22');
});
test('READtrue deduplicates only inventory-authorized shared properties and reads exact small ledger API',async()=>{
  const f=fixture();const deps=f.compact();const original=deps.resolveInventory;
  deps.resolveInventory=async args=>{const v=await original(args);v.google.available_assets.search_console.push({...v.google.available_assets.search_console[0],mapping_id:9,clinic_id:999,assignment_origin:'shared'});return v;};
  let requested;deps.searchConsoleAvailability=async input=>{requested=input;return{properties:[{siteUrl:input.siteUrls[0],totalsThrough:'2026-08-22',detailThrough:null}]};};
  const result=await f.run(deps);assert.deepEqual(Array.from(requested.siteUrls),['sc-domain:example.invalid']);
  assert.equal(requested.startDate,'2026-07-19');assert.equal(requested.endDate,'2026-08-23');
  assert.equal(f.seo(result).earned_points,15);assert.equal(f.seo(result).evidence.latest_search_console_date,'2026-08-22');
});
test('no authorized property means no compact query and no imported-data credit',async()=>{
  const f=fixture();const deps=f.compact();const original=deps.resolveInventory;
  deps.resolveInventory=async args=>{const v=await original(args);v.google.available_assets.search_console=[];return v;};
  deps.searchConsoleAvailability=denied;
  const result=await f.run(deps);assert.equal(f.seo(result).state,'needs_connection');assert.equal(f.seo(result).evidence.latest_search_console_date,null);
});
test('monthly archive labels alone never imply date coverage or recent data',async()=>{
  const f=fixture();const deps=f.compact();deps.searchConsoleAvailability=async()=>({properties:[{siteUrl:'sc-domain:example.invalid',totalsThrough:null,detailThrough:null,monthlyPeriods:['2026-08']}]});
  const result=await f.run(deps);assert.equal(f.seo(result).state,'collecting_data');assert.equal(f.seo(result).earned_points,10);assert.equal(f.seo(result).evidence.latest_search_console_date,null);
});
test('a real explicit covered day proves data existence without asserting whole interval completeness',async()=>{
  const f=fixture();const deps=f.compact();deps.searchConsoleAvailability=async()=>({properties:[{siteUrl:'sc-domain:example.invalid',totalsFrom:'2020-01-01',totalsThrough:'2026-08-22',detailFrom:null,detailThrough:null}]});
  const result=await f.run(deps);assert.equal(f.seo(result).earned_points,15);assert(!JSON.stringify(result).includes('coverage_complete'));
});
test('future, invalid, wrong-type dates and unexpected/duplicate properties fail only SEO closed',async()=>{
  const cases=[{siteUrl:'sc-domain:example.invalid',totalsThrough:'2026-08-24'},
    {siteUrl:'sc-domain:example.invalid',totalsThrough:'2026-02-30'},
    {siteUrl:'sc-domain:example.invalid',totalsThrough:new Date('2026-08-22')},
    {siteUrl:'sc-domain:foreign.invalid',totalsThrough:'2026-08-22'}];
  for(const row of cases){const f=fixture();const deps=f.compact();deps.searchConsoleAvailability=async()=>({properties:[row]});f.unknown(await f.run(deps));}
  const f=fixture();const deps=f.compact();deps.searchConsoleAvailability=async()=>({properties:[]});f.unknown(await f.run(deps));
});
test('missing inventory shape or invalid site does not reauthorize through legacy clinic fallback',async()=>{
  for(const assets of [null,[{site_url:'https://user:password@example.invalid/'}],[{}]]){
    const f=fixture();const deps=f.compact();const original=deps.resolveInventory;
    deps.resolveInventory=async args=>{const v=await original(args);v.google.available_assets.search_console=assets;return v;};
    deps.searchConsoleAvailability=denied;f.unknown(await f.run(deps));
  }
});
test('synchronous, asynchronous or missing availability failures are sanitized, no legacy fallback',async()=>{
  for(const read of [()=>{throw Error('FICTITIOUS_SQL_SECRET');},async()=>{throw Error('FICTITIOUS_SQL_SECRET');},undefined]){
    const f=fixture();const deps=f.compact();deps.searchConsoleAvailability=read;const result=await f.run(deps);f.unknown(result);assert(!JSON.stringify(result).includes('FICTITIOUS'));
  }
});
test('availability timeout returns unknown and a later rejection is handled without orphan rejection',async()=>{
  const f=fixture();const deps=f.compact();const orphan=[];const listener=e=>orphan.push(e);process.on('unhandledRejection',listener);
  try{
    deps.searchConsoleAvailability=()=>new Promise((_,reject)=>setTimeout(()=>reject(Error('FICTITIOUS_LATE')),30));
    f.unknown(await f.run(deps));await new Promise(resolve=>setTimeout(resolve,45));assert.equal(orphan.length,0);
  }finally{process.removeListener('unhandledRejection',listener);}
});
test('rejected authorized inventory is not swallowed into another clinic and never calls compact or legacy detail',async()=>{
  const f=fixture();const deps=f.compact();deps.resolveInventory=async()=>{throw Error('FICTITIOUS_SCOPE_DENIED');};deps.searchConsoleAvailability=denied;
  await assert.rejects(f.run(deps),/FICTITIOUS_SCOPE_DENIED/);
});
test('group scope remains unscored and does not resolve inventory or facts',async()=>{
  const f=fixture();const deps=f.compact();deps.resolveInventory=denied;deps.searchConsoleAvailability=denied;
  const result=await f.service.getMarketingObjectiveStatus({scopeType:'group',scopeId:9,clinicIds:[66,67]},deps);
  assert.equal(result.families[0].score,null);
});
test('actual availability factory uses only property/coverage/archive metadata, never retired query facts',async()=>{
  const f=fixture();const deps=f.compact();const source=path.join(ROOT,'src/services/searchConsoleAnalytics.service.js');
  const analytics=f.load(source,fs.readFileSync(source,'utf8'),{'node:crypto':require('node:crypto'),'../lib/searchConsoleAnalyticsContract':contract,
    '../lib/searchConsoleLegacyBackfill':require('../../lib/searchConsoleLegacyBackfill')});
  const queries=[];const property=contract.property('sc-domain:example.invalid');
  const repo=analytics.createSearchConsoleAnalytics({env:{SC_ANALYTICS_READ_ENABLED:'true'},sequelize:{transaction:denied,
    query:async(sql,options)=>{queries.push(sql);assert(options.logging===false);
      if(sql.includes('LEFT JOIN ScAnalyticsCoverageDaily'))return[[{site_hash:property.siteHash.toUpperCase(),site_url:property.siteUrl,totals_from:'2026-08-22',totals_through:'2026-08-22',detail_from:null,detail_through:null}]];
      if(sql.includes('ScAnalyticsArchiveBatches'))return[[]];return denied();}}});
  deps.searchConsoleAvailability=repo.availability;const result=await f.run(deps);assert.equal(f.seo(result).earned_points,15);assert.equal(queries.length,2);
  assert(queries.every(sql=>!sql.includes('WebScQueryDaily')&&!sql.includes('ScAnalyticsQueryDaily')));
});
test('genuine broker.prepare checks every mapping before and after ledger; dynamic revocation gives unknown',async()=>{
  const {createSearchConsoleBroker}=require('../../services/searchConsoleBroker.service');
  const revocations=require('../../services/googlePropertyRevocation.contract');
  for(const when of ['before','after']){
    const f=fixture();const deps=f.compact();let revoked=when==='before';let prepares=0;let reads=0;
    const site={...contract.property('sc-domain:example.invalid')};site.assetRef='sc:'+site.siteHash;
    const mapping={id:8,clinicaId:66,googleConnectionId:81,siteUrl:site.siteUrl,isActive:true,broker_read_connection_ref:'fictitious-sc',broker_read_asset_ref:site.assetRef};
    const binding={site_hash:site.siteHash,site_url:site.siteUrl,mapping_id:8,connection_ref:'fictitious-sc',asset_ref:site.assetRef,
      clinica_id:66,google_connection_id:81,google_user_id:'fictitious-subject',state:'active'};
    const tombstone={kind:'search_console',resource:site.siteUrl,connection_ref:'fictitious-sc',asset_ref:site.assetRef,
      clinica_id:66,google_connection_id:81,google_user_id:'fictitious-subject',state:'pending',request_id:'30000000-0000-4000-8000-000000000003',
      actor_user_id:501,requested_at:new Date('2026-08-23T11:00:00Z')};tombstone.tuple_hash=revocations.tupleHash(tombstone);
    const reader=createSearchConsoleBroker({enabled:()=>true,client:{execute:denied},loadMapping:async()=>mapping,loadBindings:async()=>[binding],
      loadConnection:async()=>({id:81,googleUserId:'fictitious-subject',credentials_external:1}),loadRevocations:async()=>revoked?[tombstone]:[]});
    deps.prepareSearchConsoleMapping=async input=>{prepares++;return reader.prepare(input);};
    deps.searchConsoleAvailability=async()=>{reads++;revoked=true;return{properties:[{siteUrl:site.siteUrl,totalsThrough:'2026-08-22',detailThrough:null}]};};
    f.unknown(await f.run(deps));assert.equal(reads,when==='before'?0:1);assert(prepares>=1);
  }
});
test('READ switched off while ledger is awaited discards its date instead of falling back',async()=>{
  const f=fixture();const deps=f.compact();let enabled=true;deps.isSearchConsoleReadEnabled=()=>enabled;
  deps.searchConsoleAvailability=async()=>{enabled=false;return{properties:[{siteUrl:'sc-domain:example.invalid',totalsThrough:'2026-08-22'}]};};
  f.unknown(await f.run(deps));
});
test('a prepare timeout does not dispatch a late ledger read and its later result is handled',async()=>{
  const f=fixture();const deps=f.compact();let reads=0;const orphan=[];const listener=e=>orphan.push(e);process.on('unhandledRejection',listener);
  try{
    deps.prepareSearchConsoleMapping=()=>new Promise(resolve=>setTimeout(resolve,30));
    deps.searchConsoleAvailability=async()=>{reads++;return{properties:[]};};
    f.unknown(await f.run(deps));await new Promise(resolve=>setTimeout(resolve,45));assert.equal(reads,0);assert.equal(orphan.length,0);
  }finally{process.removeListener('unhandledRejection',listener);}
});
