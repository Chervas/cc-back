'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const F=require('./fixtures/google_ads_goal_policy_vm.fixture');
const {ads:C,goal:G}=F,cp=x=>structuredClone(x),same=(a,b)=>assert.deepEqual(cp(a),cp(b));
const scope={assignment_scope:'group',group_id:5},payload=section=>({section,campaignIds:['101','102'],pageToken:null});
const modelIndex=path.join(F.dependencyRoot,'models/index.js');assert.equal(require.cache[modelIndex],undefined);after(()=>assert.equal(require.cache[modelIndex],undefined));
function legacyFixtures(service){
 const name='src/scripts/tests/google_ads_clinicaclick_goal_policy.test.js',source=F.read(name),body=source.slice(0,source.lastIndexOf('\nmain().catch'));
 return F.load(name,{'../../services/googleAdsClinicaclickGoalPolicy.service':service,'../../services/googleLegacyCredentials.service':F.depRequire('./src/services/googleLegacyCredentials.service'),'node:assert/strict':{...assert,deepEqual:same}},'\nmodule.exports={configuredAccount,baseSnapshot};',body);
}
function data(f){
 const originals=legacyFixtures(f.service),replace=x=>JSON.parse(JSON.stringify(x).replaceAll('1851215478',F.customer));
 const a=replace(originals.configuredAccount({owned_custom_goal_resource_name:`customers/1851215478/customConversionGoals/77`}));
 const account=cp(f.service.normalizeConfiguredAccounts([a])[0]),s=replace(originals.baseSnapshot());
 for(const g of s.custom_goals)if(g.resource_name===account.owned_custom_goal_resource_name)g.name=account.custom_goal_name;
 for(const c of s.campaign_configs)if(c.custom_conversion_goal===account.owned_custom_goal_resource_name)c.custom_goal_name=account.custom_goal_name;
 const cust={id:F.customer};
 const raw={tracking:[{customer:{...cust,conversionTrackingSetting:{googleAdsConversionCustomer:s.conversion_tracking.google_ads_conversion_customer,conversionTrackingStatus:s.conversion_tracking.conversion_tracking_status}}}],
 actions:s.conversion_actions.map(a=>({customer:cust,conversionAction:{id:a.id,resourceName:a.resource_name,ownerCustomer:a.owner_customer,name:a.name,type:a.type,status:a.status,countingType:a.counting_type,primaryForGoal:a.primary_for_goal,category:a.category,origin:a.origin}})),
 custom_goals:s.custom_goals.map(g=>({customer:cust,customConversionGoal:{id:g.id,resourceName:g.resource_name,name:g.name,status:g.status,conversionActions:g.conversion_actions}})),
 campaign_configs:s.campaign_configs.map(c=>({customer:cust,campaign:{id:c.campaign_id,name:c.campaign_name,status:c.campaign_status,advertisingChannelType:c.advertising_channel_type,...(c.advertising_channel_sub_type?{advertisingChannelSubType:c.advertising_channel_sub_type}:{})},conversionGoalCampaignConfig:{resourceName:c.resource_name,campaign:c.campaign_resource_name,goalConfigLevel:c.goal_config_level,...(c.custom_conversion_goal?{customConversionGoal:c.custom_conversion_goal}:{})},...(c.custom_conversion_goal?{customConversionGoal:{resourceName:c.custom_conversion_goal,name:c.custom_goal_name,status:c.custom_goal_status}}:{})})),
 campaign_goals:s.campaign_conversion_goals.map(g=>({customer:cust,campaign:{id:g.campaign_id,name:g.campaign_name||'Fictitious'},campaignConversionGoal:{resourceName:g.resource_name,campaign:`customers/${F.customer}/campaigns/${g.campaign_id}`,category:g.category,origin:g.origin,biddable:g.biddable}})),
 customer_goals:s.customer_conversion_goals.map(g=>({customer:cust,customerConversionGoal:{resourceName:g.resource_name,category:g.category,origin:g.origin,biddable:g.biddable}}))};
 return{account,s,raw};
}
function legacyRuntime(){return{customerId:F.customer,connection:F.connection,accessToken:'FICTITIOUS_NEVER_EXPORTED'};}
function requestFor(raw,state){return async(method,url,options)=>{state.provider++;assert.equal(method,'POST');assert.match(url,/googleAds:search$/);assert.doesNotMatch(url,/mutate|upload/);const q=options.data.query;
 const section=q.includes('FROM conversion_goal_campaign_config')?'campaign_configs':q.includes('FROM campaign_conversion_goal')?'campaign_goals':q.includes('FROM customer_conversion_goal')?'customer_goals':q.includes('FROM custom_conversion_goal')?'custom_goals':q.includes('FROM conversion_action')?'actions':'tracking';return{results:cp(raw[section])};};}
function managed(f,raw,change){
 const scoped=F.scopedFixture(),calls=[];const broker=F.facade({...scoped.options,client:{execute:async command=>{calls.push(command);await change?.(scoped,command);const result=C.projectPage('goal_policy',{results:cp(raw[command.payload.section])},command.payload,{customerId:F.customer});return{requestId:command.requestId,data:{results:result.results,nextPageToken:null}};}}});
 return{scoped,calls,broker,runtime:async()=>({deliveryMode:'broker',customerId:F.customer,account:scoped.mapping,brokerContext:await broker.prepare(scoped.mapping),broker})};
}
test('fixed six-section typed contract rejects raw queries/accounts/dates/duplicate or over200 IDs',()=>{
 assert.equal(G.SECTIONS.length,6);for(const section of G.SECTIONS){const p=payload(section);C.validate('google.ads.goal_policy.read.v1',p);const q=C.query('goal_policy',p,{customerId:F.customer});assert.match(q,/ LIMIT (2|5001)$/);assert.doesNotMatch(q,/mutate|INSERT|DELETE|UPDATE/);}
 for(const extra of[{query:'SELECT x'},{customerId:'9999999999'},{startDate:'2026-01-01'}])assert.throws(()=>G.validate({...payload('tracking'),...extra}));
 for(const campaignIds of[['1 OR 1'],['101','101'],Array.from({length:201},(_,i)=>String(i+1))])assert.throws(()=>G.validate({...payload('tracking'),campaignIds}));
});
test('full account campaign configs are not narrowed to selected campaigns; selected goal rows are',()=>{
 assert.doesNotMatch(G.query(payload('campaign_configs')),/campaign.id IN/);assert.match(G.query(payload('campaign_configs')),/campaign.status != 'REMOVED'/);
 assert.match(G.query(payload('campaign_goals')),/campaign.id IN \(101, 102\)/);assert.match(G.query(payload('actions')),/conversion_action.origin/);assert.match(G.query(payload('tracking')),/conversion_tracking_status/);
});
test('all six strict projections preserve source owner, default goals and trackingStatus/origin',()=>{
 const f=F.fixture(),d=data(f);for(const section of G.SECTIONS){const out=C.projectPage('goal_policy',{results:d.raw[section]},payload(section),{customerId:F.customer});assert.equal(out.results.length,d.raw[section].length);}
 assert.throws(()=>C.projectPage('goal_policy',{results:[]},payload('tracking'),{customerId:F.customer}));
 const foreign=cp(d.raw.actions[0]);foreign.customer.id='9999999999';assert.throws(()=>G.project(foreign,payload('actions'),{customerId:F.customer}));
 const badOwner=cp(d.raw.actions[0]);badOwner.conversionAction.ownerCustomer='customers/9999999999';assert.throws(()=>G.project(badOwner,payload('actions'),{customerId:F.customer}));
 const missing=cp(d.raw.actions[0]);delete missing.conversionAction.origin;assert.throws(()=>G.project(missing,payload('actions'),{customerId:F.customer}));
 const manager=cp(d.raw.actions[0]);manager.conversionAction.ownerCustomer='customers/9876543210';manager.conversionAction.resourceName=`customers/9876543210/conversionActions/${manager.conversionAction.id}`;assert.equal(G.project(manager,payload('actions'),{customerId:F.customer}).conversionAction.ownerCustomer,'customers/9876543210');
});
test('full account exclusivity retains other campaigns and each customer default has a distinct row key',()=>{
 const f=F.fixture(),d=data(f),r=cp(d.raw.campaign_configs[0]);r.campaign.id='999';r.conversionGoalCampaignConfig.resourceName=`customers/${F.customer}/conversionGoalCampaignConfigs/999`;r.conversionGoalCampaignConfig.campaign=`customers/${F.customer}/campaigns/999`;
 assert.equal(G.project(r,payload('campaign_configs'),{customerId:F.customer}).campaign.id,'999');
 const goals=[{category:'SUBMIT_LEAD_FORM',origin:'WEBSITE'},{category:'PURCHASE',origin:'WEBSITE'}].map(g=>({customer:{id:F.customer},customerConversionGoal:{resourceName:`customers/${F.customer}/customerConversionGoals/${g.category}~${g.origin}`,...g,biddable:true}}));
 assert.equal(C.projectPage('goal_policy',{results:goals},payload('customer_goals'),{customerId:F.customer}).results.length,2);
});
test('genuine facade/account/opaque scope reaches six READs and snapshot equals the guarded legacy projection',async()=>{
 const f=F.fixture(),d=data(f),m=managed(f,d.raw),runtime=await m.runtime();
 const actual=await f.service.fetchGoalPolicySnapshot({runtime,account:d.account});
 const legacy=await f.service.fetchGoalPolicySnapshot({runtime:legacyRuntime(),account:d.account,request:requestFor(d.raw,f.state)});
 same(actual,legacy);assert.equal(m.calls.length,6);assert.equal(f.state.provider,6);assert.ok(f.state.checks>=96);
 for(const c of m.calls){assert.equal(c.operation,'google.ads.goal_policy.read.v1');assert.equal(c.assetRef,'ads:'+F.customer);assert.equal(c.tenantRef,'clinic:59');assert.equal(Object.hasOwn(c.payload,'query'),false);}
 assert.ok(m.scoped.state.calls.filter(x=>x.kind==='mapping').length>=24);
});
test('managed preview preserves actual planner and deterministic digest, and never reads a token',async()=>{
 const f=F.fixture(),d=data(f),m=managed(f,d.raw);const managedPreview=await f.service.previewClinicaclickGoalPolicy({scope,configuredAccounts:[d.account],dependencies:{resolveRuntime:m.runtime,request:()=>{throw Error('TOKEN_FALLBACK_FORBIDDEN');}}});
 const legacyPreview=await f.service.previewClinicaclickGoalPolicy({scope,configuredAccounts:[d.account],dependencies:{resolveRuntime:async()=>legacyRuntime(),request:requestFor(d.raw,f.state)}});
 assert.equal(managedPreview.digest,legacyPreview.digest);same(managedPreview.accounts,legacyPreview.accounts);assert.equal(m.calls.length,6);assert.equal(managedPreview.accounts[0].error,undefined);
});
test('managed apply is explicitly closed before provider READ/WRITE, even with confirmation and syntactic digest',async()=>{
 const f=F.fixture(),d=data(f),m=managed(f,d.raw);await assert.rejects(f.service.applyClinicaclickGoalPolicy({scope,configuredAccounts:[d.account],expectedDigest:'a'.repeat(64),confirmExternalMutation:true,dependencies:{resolveRuntime:m.runtime,request:()=>{throw Error('TOKEN_FALLBACK_FORBIDDEN');}}}),{code:'GOAL_POLICY_BROKER_APPLY_UNAVAILABLE'});assert.equal(m.calls.length,0);assert.equal(f.state.provider,0);assert.equal(f.state.checks,0);
});
test('actual facade rejects old three-argument ABI/forged account/context before transport',async()=>{
 const f=F.fixture(),d=data(f),m=managed(f,d.raw),runtime=await m.runtime(),p={section:'tracking',campaignIds:d.account.campaign_ids};
 await assert.rejects(m.broker.read(runtime.brokerContext,'goal_policy',p),{code:'broker_binding_invalid'});
 await assert.rejects(m.broker.read({...runtime.account,id:999},runtime.brokerContext,'goal_policy',p),{code:'broker_binding_invalid'});
 await assert.rejects(m.broker.read(runtime.account,{},'goal_policy',p),{code:'broker_binding_invalid'});assert.equal(m.calls.length,0);
});
test('late managed revocation discards all rows without legacy fallback or weaker READ retry',async()=>{
 const f=F.fixture(),d=data(f),m=managed(f,d.raw,(s)=>{s.state.bindings[0].state='blocked';});
 await assert.rejects(f.service.fetchGoalPolicySnapshot({runtime:await m.runtime(),account:d.account,request:()=>{throw Error('FALLBACK_FORBIDDEN');}}),/asset_revoked/);assert.equal(m.calls.length,1);assert.equal(f.state.checks,0);
});
test('each eight-registry marker closes legacy before a request; late markers also discard a response',async()=>{
 for(const name of F.fixture().names){const f=F.fixture(),d=data(f);f.state.blocked=name;await assert.rejects(f.service.fetchGoalPolicySnapshot({runtime:legacyRuntime(),account:d.account,request:requestFor(d.raw,f.state)}),/google_oauth_legacy_closed/);assert.equal(f.state.provider,0,name);}
 const f=F.fixture(),d=data(f),base=requestFor(d.raw,f.state);await assert.rejects(f.service.fetchGoalPolicySnapshot({runtime:legacyRuntime(),account:d.account,request:async(...args)=>{const value=await base(...args);f.state.blocked=true;return value;}}),/google_oauth_legacy_closed/);assert.equal(f.state.provider,1);
});
test('legacy provider errors still cross the post-request eight-registry guard',async()=>{
 const f=F.fixture(),d=data(f);await assert.rejects(f.service.fetchGoalPolicySnapshot({runtime:legacyRuntime(),account:d.account,request:async()=>{f.state.provider++;f.state.blocked='analyticsModel';throw Object.assign(Error('FICTITIOUS_PROVIDER_FAILED'),{code:'provider_failed'});}}),/google_oauth_legacy_closed/);assert.equal(f.state.provider,1);assert.equal(f.state.checkedRegistries.filter(x=>x==='analyticsModel').length,2);assert.ok(f.state.checks>8);
});
test('reader cap/saturation cannot return a successful partial snapshot',async()=>{
 const f=F.fixture(),d=data(f),scoped=F.scopedFixture();let calls=0;const broker=F.facade({...scoped.options,client:{execute:async command=>{calls++;return{requestId:command.requestId,data:{results:cp(d.raw.actions).slice(0,1),nextPageToken:'same-token'}};}}});const ctx=await broker.prepare(scoped.mapping);
 await assert.rejects(broker.read(scoped.mapping,ctx,'goal_policy',{section:'actions',campaignIds:['101']}),/broker_response_invalid/);assert.equal(calls,2);
});
const LEGACY_BODY_HASHES=["5f16e03684083b48ccabf085721ee266edc633f9d9de1cc3f6cf9ba0453089d0", "c0554e451c354f319686e05d4411af9fda42dbc4e8e518f49f0866fa66b528dc", "79e73061cd33559d55183fcacdf41843f32baa1928605b74e1ce8dfea730dcf4", "65df6652007c83dba6ed9ff1e0a2b1c875731cae75d882afa5a3dbdff3b7c7c0", "4acd925913e13eb160e747ba3a7683c018a3d5f013e91f8f991f01ade08a3af3", "cf34e3339a32e1f9a5fad32d78dfef32286a5bb308921e1766bca5dc26e83217"];
test('all six original legacy GAQL bodies are byte-exact',()=>{
 const source=F.read('src/services/googleAdsClinicaclickGoalPolicy.service.js'),a=source.indexOf('async function fetchGoalPolicySnapshot'),body=source.slice(a,source.indexOf('\nfunction',a));
 const hashes=[...body.matchAll(/query:\s*\[([\s\S]*?)\]\.join\('\\n'\)/g)].map(m=>crypto.createHash('sha256').update(m[1]).digest('hex'));same(hashes,LEGACY_BODY_HASHES);
});

test('genuine reader saturation at5000 with another provider page cannot publish a partial preview',async()=>{
 const f=F.fixture(),d=data(f),scoped=F.scopedFixture();let calls=0;const rows=Array.from({length:5001},(_,i)=>{const r=cp(d.raw.actions[0]);r.conversionAction.id=String(i+1000);r.conversionAction.resourceName=`customers/${F.customer}/conversionActions/${r.conversionAction.id}`;return r;});
 const broker=F.facade({...scoped.options,client:{execute:async command=>{calls++;if(command.payload.section==='tracking')return{requestId:command.requestId,data:{results:d.raw.tracking,nextPageToken:null}};
  assert.equal(command.payload.section,'actions');const offset=command.payload.pageToken===null?0:Number(command.payload.pageToken);const part=rows.slice(offset,offset+250),next=offset+part.length<rows.length?String(offset+part.length):null;
  return{requestId:command.requestId,data:{results:part,nextPageToken:next}};
 }}});const context=await broker.prepare(scoped.mapping);
 const preview=await f.service.previewClinicaclickGoalPolicy({scope,configuredAccounts:[d.account],dependencies:{resolveRuntime:async()=>({deliveryMode:'broker',customerId:F.customer,account:scoped.mapping,brokerContext:context,broker}),request:()=>{throw Error('FALLBACK_FORBIDDEN');}}});
 assert.equal(calls,21);assert.equal(preview.accounts[0].outcome,'failed');assert.equal(preview.accounts[0].error.code,'broker_response_invalid');assert.equal(f.state.checks,0);
});

async function changedPolicyFixture(){
 const f=F.fixture(),d=data(f);d.raw.custom_goals.push({customer:{id:F.customer},customConversionGoal:{id:'77',resourceName:d.account.owned_custom_goal_resource_name,name:d.account.custom_goal_name,status:'ENABLED',conversionActions:[]}});
 const preview=await f.service.previewClinicaclickGoalPolicy({scope,configuredAccounts:[d.account],dependencies:{resolveRuntime:async()=>legacyRuntime(),request:requestFor(d.raw,f.state)}});
 assert.equal(preview.accounts[0].plan.changed,true);assert.equal(preview.accounts[0].plan.ready,true,JSON.stringify(preview.accounts[0].plan.blockers));f.state.provider=0;
 return{f,d,expectedDigest:preview.digest};
}
test('same-digest legacy-to-managed change during preview cannot authorize even validateOnly HTTP',async()=>{
 const {f,d,expectedDigest}=await changedPolicyFixture(),m=managed(f,d.raw);let resolutions=0,mutates=0;
 const brokerRuntime=await m.runtime();
 await assert.rejects(f.service.applyClinicaclickGoalPolicy({scope,configuredAccounts:[d.account],expectedDigest,confirmExternalMutation:true,dependencies:{resolveRuntime:async()=>++resolutions===1?legacyRuntime():brokerRuntime,request:async()=>{mutates++;throw Error('MUTATE_FORBIDDEN');}}}),{code:'GOAL_POLICY_BROKER_APPLY_UNAVAILABLE'});
 assert.equal(m.calls.length,6);assert.equal(resolutions,3);assert.equal(mutates,0);assert.equal(f.state.provider,0);
});
