'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID,generateKeyPairSync}=require('node:crypto');
const deny=()=>{throw Error('NETWORK_FORBIDDEN_IN_GOAL_WRITE_QA');};require('node:net').Socket.prototype.connect=deny;require('node:tls').connect=deny;global.fetch=deny;
const {BrokerStore}=require('../src/store'),{Broker}=require('../src/broker'),{signRequest}=require('../src/auth');
const C=require('../src/google-goal-policy-write-contract'),P=require('../src/google-goal-policy-plan');
const {createGoogleGoalPolicyWrites}=require('../src/google-goal-policy-writes');
const CUSTOMER='1234567890',ASSET='ads:'+CUSTOMER,GOAL=`customers/${CUSTOMER}/customConversionGoals/88`;
const actionIds={lead:'1',contact:'2',qualified_lead:'3',schedule:'4',purchase:'5'};
function setup(t,{owned=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc-goal-write-unit-'));const filename=path.join(dir,'ledger.sqlite');let store=new BrokerStore(filename),at=Date.now();
 const keys=generateKeyPairSync('ed25519'),binding={connectionRef:'connection:fictitious',provider:'google_ads',initialState:'active',googleSubject:'fictitious-subject',
  googleAdsAccounts:[{assetRef:ASSET,customerId:CUSTOMER,loginCustomerId:null}],googleAdsGoalPolicy:{accounts:[{assetRef:ASSET,strategyRef:'strategy:fictitious',stage:'qualified_lead',campaignIds:['10'],canonicalActionIds:actionIds,ownedGoalResourceName:owned?GOAL:null,allowCreate:true,allowUpdate:true}]}};
 const policy={audience:'broker:fictitious',version:'v1',maxBacklog:10000,principals:[{id:'principal:fictitious',keyId:'key:fictitious',enabled:true,publicKey:keys.publicKey.export({type:'spki',format:'pem'}),maxPerMinute:600}],
  connections:[binding],grants:[{principalId:'principal:fictitious',tenantRef:'clinic:9',connectionRef:binding.connectionRef,assetRef:ASSET,operations:Object.values(C.OPERATIONS)}]};
 const account=C.resource(binding,ASSET,{strategyRef:'strategy:fictitious',stage:'qualified_lead',campaignIds:['10']}).account;
 const state={calls:[],writes:0,validations:0,reads:0,afterWrite:null,onRead:null,onValidation:null,now:()=>at};
 state.snapshot={conversion_tracking:{customer_id:CUSTOMER,google_ads_conversion_customer:`customers/${CUSTOMER}`,conversion_customer_id:CUSTOMER,conversion_tracking_status:'CONVERSION_TRACKING_MANAGED_BY_SELF'},
  conversion_actions:Object.entries(actionIds).map(([key,id])=>({id,resource_name:`customers/${CUSTOMER}/conversionActions/${id}`,owner_customer:`customers/${CUSTOMER}`,name:P.CANONICAL_ACTIONS[key].name,type:'UPLOAD_CLICKS',status:'ENABLED',counting_type:'MANY_PER_CLICK',primary_for_goal:false,category:key==='schedule'?'BOOK_APPOINTMENT':key==='purchase'?'PURCHASE':'SUBMIT_LEAD_FORM',origin:'WEBSITE'})),
  custom_goals:owned?[{id:'88',resource_name:GOAL,name:account.custom_goal_name,status:'ENABLED',conversion_actions:[`customers/${CUSTOMER}/conversionActions/3`]}]:[],
  campaign_configs:[{resource_name:`customers/${CUSTOMER}/conversionGoalCampaignConfigs/10`,campaign_resource_name:`customers/${CUSTOMER}/campaigns/10`,campaign_id:'10',campaign_name:'Fictitious campaign',campaign_status:'ENABLED',advertising_channel_type:'SEARCH',advertising_channel_sub_type:null,goal_config_level:owned?'CAMPAIGN':'CUSTOMER',custom_conversion_goal:owned?GOAL:null,custom_goal_name:owned?account.custom_goal_name:null,custom_goal_status:owned?'ENABLED':null}],
  campaign_conversion_goals:[{resource_name:`customers/${CUSTOMER}/campaignConversionGoals/10~SUBMIT_LEAD_FORM~WEBSITE`,campaign_id:'10',campaign_name:'Fictitious campaign',category:'SUBMIT_LEAD_FORM',origin:'WEBSITE',biddable:true}],
  customer_conversion_goals:[{resource_name:`customers/${CUSTOMER}/customerConversionGoals/SUBMIT_LEAD_FORM~WEBSITE`,category:'SUBMIT_LEAD_FORM',origin:'WEBSITE',biddable:true}]};
 const rows=section=>{
  const s=state.snapshot,customer={id:CUSTOMER};
  const camel=obj=>Object.fromEntries(Object.entries(obj).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]));
  if(section==='tracking')return[{customer:{...customer,conversionTrackingSetting:{googleAdsConversionCustomer:s.conversion_tracking.google_ads_conversion_customer,conversionTrackingStatus:s.conversion_tracking.conversion_tracking_status}}}];
  if(section==='actions')return s.conversion_actions.map(a=>({customer,conversionAction:camel(a)}));
  if(section==='custom_goals')return s.custom_goals.map(g=>({customer,customConversionGoal:camel(g)}));
  if(section==='campaign_configs')return s.campaign_configs.map(g=>({customer,campaign:{id:g.campaign_id,name:g.campaign_name,status:g.campaign_status,advertisingChannelType:g.advertising_channel_type,...(g.advertising_channel_sub_type?{advertisingChannelSubType:g.advertising_channel_sub_type}:{})},conversionGoalCampaignConfig:{resourceName:g.resource_name,campaign:g.campaign_resource_name,goalConfigLevel:g.goal_config_level,...(g.custom_conversion_goal?{customConversionGoal:g.custom_conversion_goal}:{})},...(g.custom_conversion_goal?{customConversionGoal:{resourceName:g.custom_conversion_goal,name:g.custom_goal_name,status:g.custom_goal_status}}:{})}));
  if(section==='campaign_goals')return s.campaign_conversion_goals.map(g=>({customer,campaign:{id:g.campaign_id,name:g.campaign_name},campaignConversionGoal:{resourceName:g.resource_name,campaign:`customers/${CUSTOMER}/campaigns/${g.campaign_id}`,category:g.category,origin:g.origin,biddable:g.biddable}}));
  return s.customer_conversion_goals.map(g=>({customer,customerConversionGoal:camel(g)}));
 };
 const http=async req=>{
  state.calls.push({path:req.path,phase:req.goalPolicyMutation,validateOnly:req.json?.validateOnly});
  if(req.path.endsWith('/googleAds:search')){
   state.reads++;await state.onRead?.(req);
   const from=req.json.query.match(/ FROM (\w+)/)[1],map={customer:'tracking',conversion_action:'actions',custom_conversion_goal:'custom_goals',conversion_goal_campaign_config:'campaign_configs',campaign_conversion_goal:'campaign_goals',customer_conversion_goal:'customer_goals'};
   return state.responseOverride?.(map[from],req)||{results:structuredClone(rows(map[from]))};
  }
  C.validateMutation(req.path,req.goalPolicyMutation,req.json);
  if(req.json.validateOnly){state.validations++;await state.onValidation?.(req);return {};}
  state.writes++;
  const names=req.json.operations.map(op=>{
   if(req.goalPolicyMutation==='goal'){
    if(op.create)state.snapshot.custom_goals.push({id:'88',resource_name:GOAL,name:op.create.name,status:'ENABLED',conversion_actions:[...op.create.conversionActions].sort()});
    else state.snapshot.custom_goals.find(g=>g.resource_name===op.update.resourceName).conversion_actions=[...op.update.conversionActions].sort();return op.update?.resourceName||GOAL;
   }
   if(req.goalPolicyMutation==='campaign_config'){
    const g=state.snapshot.campaign_configs.find(g=>g.resource_name===op.update.resourceName),goal=state.snapshot.custom_goals.find(g=>g.resource_name===op.update.customConversionGoal);
    Object.assign(g,{custom_conversion_goal:op.update.customConversionGoal,goal_config_level:'CAMPAIGN',custom_goal_name:goal.name,custom_goal_status:goal.status});
   }else state.snapshot.campaign_conversion_goals.find(g=>g.resource_name===op.update.resourceName).biddable=false;
   return op.update.resourceName;
  });
  await state.afterWrite?.(req);return state.rawMutation||{results:names.map(resourceName=>({resourceName}))};
 };
 let engine,broker;const reset=()=>{engine=createGoogleGoalPolicyWrites({store,http,withDeveloperSecret:(_binding,work)=>work(Buffer.from('FICTITIOUS_DEVELOPER')),now:()=>at});for(const op of Object.values(engine.operations)){const original=op.execute;op.execute=async c=>{try{return await original(c);}catch(e){state.lastInternalError=e.stack;throw e;}};}broker=new Broker({store,policy,secrets:{withSecret:(_binding,work)=>work(Buffer.from('FICTITIOUS_ACCESS')),invalidate(){}},operations:engine.operations,now:()=>at,timeoutMs:state.timeoutMs||10000});};reset();
 const execute=(family,payload,id=randomUUID())=>{const request={version:1,requestId:id,operation:C.OPERATIONS[family],connectionRef:binding.connectionRef,tenantRef:'clinic:9',assetRef:ASSET,payload};const signed=signRequest(request,{keyId:'key:fictitious',privateKey:keys.privateKey,audience:policy.audience,now:at});return broker.execute(signed.raw,signed.headers).catch(e=>{e.fixtureInternal=state.lastInternalError;throw e;});};
 const prepare=()=>execute('prepare',{strategyRef:'strategy:fictitious',stage:'qualified_lead',campaignIds:['10'],expectedDigest:P.buildClinicaclickGoalPolicyPlan({account:C.resource(binding,ASSET,{strategyRef:'strategy:fictitious',stage:'qualified_lead',campaignIds:['10']}).account,snapshot:state.snapshot}).plan_digest});
 const phase=(planId,p,previous=null,ownership=null)=>({planId,phase:p,expectedPreviousAckSha256:previous,ownership});
 const witness=s=>({planId:s.planId,customerId:CUSTOMER,goalResourceName:GOAL,goalAckSha256:s.phases[0].receiptSha256,commitRefSha256:'a'.repeat(64),mandateSha256:'b'.repeat(64)});
 t.after(()=>{try{store.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
 return{state,account,binding,policy,execute,prepare,phase,witness,get store(){return store;},reset,
  reopen(){store.close();store=new BrokerStore(filename);reset();},advance(ms){at+=ms;}};
}
test('real signed Broker/SQLite executes three explicit phases; ownership required; no-op/status never replay',async t=>{
 const f=setup(t),p=(await f.prepare()).data;assert.equal(f.state.writes,0);
 const a=(await f.execute('apply',f.phase(p.planId,'goal'))).data;assert.equal(a.phases[0].state,'ack');assert.equal(a.phases[0].resources[0],GOAL);assert.equal(f.state.writes,1);
 await assert.rejects(f.execute('apply',f.phase(p.planId,'campaign_config',a.phases[0].receiptSha256)),{code:'scope_denied'});assert.equal(f.state.writes,1);
 const b=(await f.execute('apply',f.phase(p.planId,'campaign_config',a.phases[0].receiptSha256,f.witness(a)))).data;
 const c=(await f.execute('apply',f.phase(p.planId,'campaign_goals',b.phases[1].receiptSha256,f.witness(b)))).data;
 assert.equal(c.state,'complete');assert.equal(f.state.writes,3);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM google_goal_policy_locks').get().n,0);
 const calls=f.state.calls.length;await f.execute('status',{planId:p.planId});await f.execute('apply',f.phase(p.planId,'goal'));assert.equal(f.state.calls.length,calls);
 const text=JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all());assert(!text.includes('FICTITIOUS_ACCESS'));assert(!text.includes('FICTITIOUS_DEVELOPER'));
});
test('UNKNOWN after dispatch survives restart/new UUID/expiry and competing no-op plan cannot steal locks',async t=>{
 const f=setup(t),p=(await f.prepare()).data;f.state.afterWrite=()=>{throw Error('FICTITIOUS_LOST_ACK');};
 await assert.rejects(f.execute('apply',f.phase(p.planId,'goal')),{code:'provider_failed'});assert.equal(f.state.writes,1);f.state.afterWrite=null;
 f.reopen();const s=(await f.execute('status',{planId:p.planId})).data;assert.equal(s.phases[0].state,'unknown');assert.equal(s.phases[0].attemptedMutationCount,1);assert.equal(s.phases[0].knownMutationCount,0);
 await assert.rejects(f.execute('apply',f.phase(p.planId,'goal')),{code:'outcome_unknown'});f.advance(400000);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM google_goal_policy_locks').get().n,2);assert.equal(f.state.writes,1);
});
test('known provider ACK is durable before post-response revocation and status preserves resource/count',async t=>{
 const f=setup(t),p=(await f.prepare()).data;
 f.state.afterWrite=()=>f.store.db.prepare("UPDATE connections SET revision=revision+1 WHERE ref=?").run(f.binding.connectionRef);
 await assert.rejects(f.execute('apply',f.phase(p.planId,'goal')),{code:'connection_blocked'});f.state.afterWrite=null;f.reopen();
 const s=(await f.execute('status',{planId:p.planId})).data;assert.equal(s.phases[0].state,'ack');assert.equal(s.phases[0].knownMutationCount,1);assert.equal(s.phases[0].resources[0],GOAL);assert.equal(f.state.writes,1);
});
test('generic command-completion failure cannot erase phase ACK',async t=>{
 const f=setup(t),p=(await f.prepare()).data,complete=f.store.complete.bind(f.store);let failOnce=true;
 f.store.complete=(...args)=>{if(failOnce){failOnce=false;throw Error('FICTITIOUS_SQLITE_COMPLETE_FAIL');}return complete(...args);};
 await assert.rejects(f.execute('apply',f.phase(p.planId,'goal')));f.store.complete=complete;
 const s=(await f.execute('status',{planId:p.planId})).data;assert.equal(s.phases[0].state,'ack');assert.equal(s.phases[0].resources[0],GOAL);assert.equal(f.state.writes,1);
});
test('concurrent applies serialize durable INTENT and perform one real mutation',async t=>{
 const f=setup(t),p=(await f.prepare()).data;
 const values=await Promise.allSettled([f.execute('apply',f.phase(p.planId,'goal')),f.execute('apply',f.phase(p.planId,'goal'))]);
 assert.equal(f.state.writes,1);assert(values.some(r=>r.status==='fulfilled'));const s=(await f.execute('status',{planId:p.planId})).data;assert.equal(s.phases[0].state,'ack');
});
test('stale digest, foreign campaign, changed account metadata and invalid payloads send zero mutations',async t=>{
 const f=setup(t);await assert.rejects(f.execute('prepare',{strategyRef:'strategy:fictitious',stage:'qualified_lead',campaignIds:['10'],expectedDigest:'f'.repeat(64)}),{code:'action_plan_conflict'});
 for(const payload of [{strategyRef:'strategy:fictitious',stage:'qualified_lead',campaignIds:['999'],expectedDigest:'f'.repeat(64)},{strategyRef:'strategy:fictitious',stage:'qualified_lead',campaignIds:['10'],expectedDigest:'f'.repeat(64),operations:[]}])await assert.rejects(f.execute('prepare',payload));
 const p=(await f.prepare()).data;f.state.snapshot.campaign_configs[0].campaign_status='PAUSED';await assert.rejects(f.execute('apply',f.phase(p.planId,'goal')),{code:'action_plan_conflict'});assert.equal(f.state.writes,0);
});
test('malformed/foreign provider ACK remains UNKNOWN, never bindable',async t=>{
 const f=setup(t),p=(await f.prepare()).data;f.state.rawMutation={results:[{resourceName:'customers/9999999999/customConversionGoals/88'}]};
 await assert.rejects(f.execute('apply',f.phase(p.planId,'goal')),{code:'provider_failed'});const s=(await f.execute('status',{planId:p.planId})).data;assert.equal(s.phases[0].state,'unknown');assert.equal(s.phases[0].resources.length,0);
});
test('SMART/cross-account planner blockers and saturated/duplicate inventory are closed',async t=>{
 const f=setup(t);f.state.snapshot.campaign_configs[0].advertising_channel_type='SMART';await assert.rejects(f.prepare());f.state.snapshot.campaign_configs[0].advertising_channel_type='SEARCH';
 f.state.snapshot.conversion_tracking.google_ads_conversion_customer='customers/9999999999';f.state.snapshot.conversion_tracking.conversion_customer_id='9999999999';await assert.rejects(f.prepare());
 f.state.snapshot.conversion_tracking.google_ads_conversion_customer=`customers/${CUSTOMER}`;f.state.snapshot.conversion_tracking.conversion_customer_id=CUSTOMER;
 f.state.responseOverride=section=>section==='tracking'?{results:[]}:null;await assert.rejects(f.prepare(),{code:'provider_failed'});assert.equal(f.state.writes,0);
});

test('permanent locks block a fresh reviewed plan after an UNKNOWN create, even with a new UUID',async t=>{
 const f=setup(t),p=(await f.prepare()).data;f.state.afterWrite=()=>{throw Error('lost');};await assert.rejects(f.execute('apply',f.phase(p.planId,'goal')));f.state.afterWrite=null;
 // A new caller may now see a named goal but has no durable ownership. Even a
 // reviewed binding for that exact observed goal cannot steal the attempted lock.
 f.binding.googleAdsGoalPolicy.accounts[0].ownedGoalResourceName=GOAL;f.reset();
 const next=(await f.prepare()).data;await assert.rejects(f.execute('apply',f.phase(next.planId,'goal')),{code:'action_plan_busy'});assert.equal(f.state.writes,1);
});
test('ACK last phase with completion failure stays locked; status/duplicate apply cannot finalize without fresh readback',async t=>{
 const f=setup(t),p=(await f.prepare()).data,a=(await f.execute('apply',f.phase(p.planId,'goal'))).data;
 const b=(await f.execute('apply',f.phase(p.planId,'campaign_config',a.phases[0].receiptSha256,f.witness(a)))).data;
 const complete=f.store.complete.bind(f.store);let failOnce=true;f.store.complete=(...args)=>{if(failOnce){failOnce=false;throw Error('completion lost');}return complete(...args);};
 const payload=f.phase(p.planId,'campaign_goals',b.phases[1].receiptSha256,f.witness(b));await assert.rejects(f.execute('apply',payload));f.store.complete=complete;
 const before=f.state.calls.length,s=(await f.execute('status',{planId:p.planId})).data;assert.equal(s.phases[2].state,'ack');assert.equal(s.state,'active');
 await f.execute('apply',payload);assert.equal(f.state.calls.length,before);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM google_goal_policy_locks').get().n,2);
 f.state.snapshot.campaign_configs[0].campaign_status='PAUSED';await assert.rejects(f.execute('validate',payload),{code:'action_plan_conflict'});
 f.state.snapshot.campaign_configs[0].campaign_status='ENABLED';const v=(await f.execute('validate',payload)).data;assert.equal(v.state,'complete');assert.equal(f.state.writes,3);
});
test('foreign ownership or wrong previous receipt blocks before any binding call',async t=>{
 const f=setup(t),p=(await f.prepare()).data,a=(await f.execute('apply',f.phase(p.planId,'goal'))).data;const count=f.state.calls.length;
 for(const own of [{...f.witness(a),goalResourceName:'customers/9999999999/customConversionGoals/88'},{...f.witness(a),goalAckSha256:'f'.repeat(64)}])await assert.rejects(f.execute('apply',f.phase(p.planId,'campaign_config',a.phases[0].receiptSha256,own)),{code:'scope_denied'});
 await assert.rejects(f.execute('apply',f.phase(p.planId,'campaign_config','f'.repeat(64),f.witness(a))),{code:'action_plan_conflict'});assert.equal(f.state.calls.length,count);
});
test('expiry or revocation during validate-only reaches no real mutation',async t=>{
 const f=setup(t),p=(await f.prepare()).data;f.state.onValidation=()=>f.advance(C.TTL_MS+1);
 await assert.rejects(f.execute('apply',f.phase(p.planId,'goal')),{code:'action_plan_expired'});assert.equal(f.state.writes,0);
});

test('dedicated cohort rejects reader/conversion/OAuth grants and unbound writer configuration',t=>{
 const f=setup(t),main=require('../src/google-main');Object.assign(f.binding,{secretArn:'fictitious-secret',clientSecretArn:'fictitious-client',developerSecretArn:'fictitious-developer'});
 const config={enabled:true,cohort:C.COHORT,listenAddress:'127.0.0.1',port:8443,stateFile:'/fictitious/ledger.sqlite',policy:f.policy,tlsCertFile:'/fictitious/cert',tlsKeyFile:'/fictitious/key',cursorKeyFile:'/fictitious/cursor'};
 assert.equal(main.validateConfig(config),config);
 const wrong=structuredClone(config);wrong.cohort='google-ads-read-v1';assert.throws(()=>main.validateConfig(wrong));
 for(const op of ['google.ads.account.read.v1','google.ads.conversion_actions.apply.v1','google.oauth.begin.v1']){const x=structuredClone(config);x.policy.grants[0].operations.push(op);assert.throws(()=>main.validateConfig(x));}
 const duplicate=structuredClone(config);duplicate.policy.connections[0].googleAdsGoalPolicy.accounts.push({...duplicate.policy.connections[0].googleAdsGoalPolicy.accounts[0],strategyRef:'other'});assert.throws(()=>main.validateConfig(duplicate));
});
test('genuine HTTP transport permits only private typed selectors with fixed TLS origin and masks',async()=>{
 const {createGoogleHttp}=require('../src/google-http'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');const calls=[];
 const request=(options,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{calls.push({options,body});queueMicrotask(()=>{const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'application/json'};callback(res);res.end('{}');});};return req;};
 const http=createGoogleHttp({request,goalPolicyEnabled:true}),base={hostname:'googleads.googleapis.com',path:C.endpoint(CUSTOMER,'goal'),token:Buffer.from('FICTITIOUS_ACCESS'),developerToken:Buffer.from('FICTITIOUS_DEVELOPER'),loginCustomerId:null,goalPolicyMutation:'goal',json:{operations:[{create:{name:'Clinicaclick · Nuevos pacientes · fixture',conversionActions:[`customers/${CUSTOMER}/conversionActions/3`],status:'ENABLED'}}],validateOnly:true,responseContentType:'RESOURCE_NAME_ONLY'}};
 await http(base);assert.equal(calls.length,1);assert.equal(calls[0].options.rejectUnauthorized,true);assert.equal(calls[0].options.hostname,'googleads.googleapis.com');assert.equal(calls[0].options.method,'POST');
 for(const patch of [{hostname:'evil.invalid'},{path:`/v24/customers/${CUSTOMER}/customerConversionGoals:mutate`},{goalPolicyMutation:'conversion_actions'}, {json:{...base.json,partialFailure:true}},{json:{...base.json,operations:[{remove:GOAL}]}},{json:{...base.json,operations:[{update:{resourceName:GOAL,conversionActions:[`customers/${CUSTOMER}/conversionActions/1`,`customers/${CUSTOMER}/conversionActions/3`]},updateMask:'conversion_actions'}]}}])await assert.rejects(http({...base,...patch}),{code:'invalid_request'});
 await assert.rejects(createGoogleHttp({request})(base),{code:'invalid_request'});assert.equal(calls.length,1);
});
test('transport timeout returns UNKNOWN first; late genuine ACK is retained without a second dispatch',async t=>{
 const f=setup(t),p=(await f.prepare()).data;f.state.timeoutMs=10;f.reset();
 let release;f.state.afterWrite=()=>new Promise(resolve=>{release=resolve;});const commandId=randomUUID();
 const pending=f.execute('apply',f.phase(p.planId,'goal'),commandId).then(()=>null,e=>e);
 while(!release)await new Promise(r=>setTimeout(r,1));
 const failure=await pending;assert.equal(failure.code,'provider_timeout');
 const before=(await f.execute('status',{planId:p.planId})).data;assert.equal(before.phases[0].state,'unknown');
 release();f.state.afterWrite=null;
 let current;for(let i=0;i<100;i++){current=JSON.parse(f.store.db.prepare('SELECT phases_json FROM google_goal_policy_plans WHERE id=?').get(p.planId).phases_json);if(current[0].state==='ack')break;await new Promise(r=>setTimeout(r,1));}
 assert.equal(current[0].state,'ack');assert.equal(current[0].resources[0],GOAL);assert.equal(f.state.writes,1);
 await assert.rejects(f.execute('apply',f.phase(p.planId,'goal'),commandId),{code:'outcome_unknown'});assert.equal(f.state.writes,1);
});

test('v24 protobuf field sets differ per endpoint; partialFailure and campaignGoals responseContentType always rejected',()=>{
 const values={goal:[{create:{name:'Clinicaclick · Nuevos pacientes · fixture',conversionActions:[`customers/${CUSTOMER}/conversionActions/3`],status:'ENABLED'}}],
  campaign_config:[{update:{resourceName:`customers/${CUSTOMER}/conversionGoalCampaignConfigs/10`,customConversionGoal:GOAL},updateMask:'custom_conversion_goal'}],
  campaign_goals:[{update:{resourceName:`customers/${CUSTOMER}/campaignConversionGoals/10~SUBMIT_LEAD_FORM~WEBSITE`,biddable:false},updateMask:'biddable'}]};
 for(const phase of C.PHASES){const body={operations:values[phase],validateOnly:true,...(phase==='campaign_goals'?{}:{responseContentType:'RESOURCE_NAME_ONLY'})};
  C.validateMutation(C.endpoint(CUSTOMER,phase),phase,body);assert.throws(()=>C.validateMutation(C.endpoint(CUSTOMER,phase),phase,{...body,partialFailure:false}),{code:'invalid_request'});
  if(phase==='campaign_goals')assert.throws(()=>C.validateMutation(C.endpoint(CUSTOMER,phase),phase,{...body,responseContentType:'RESOURCE_NAME_ONLY'}),{code:'invalid_request'});
 }
});

test('valid permitted large cohort is rejected before any INTENT or provider mutation, with no cap increase',async t=>{
 const f=setup(t),ids=Array.from({length:200},(_,i)=>String(i+100));
 f.binding.googleAdsGoalPolicy.accounts[0].campaignIds=ids;f.reset();
 const config=f.state.snapshot.campaign_configs[0],goal=f.state.snapshot.campaign_conversion_goals[0];
 f.state.snapshot.campaign_configs=ids.map(id=>({...config,campaign_id:id,resource_name:`customers/${CUSTOMER}/conversionGoalCampaignConfigs/${id}`,campaign_resource_name:`customers/${CUSTOMER}/campaigns/${id}`}));
 f.state.snapshot.campaign_conversion_goals=ids.flatMap(id=>Array.from({length:10},(_,j)=>{const category='CATEGORY_'+String.fromCharCode(65+j),origin='WEBSITE';return{...goal,campaign_id:id,category,origin,resource_name:`customers/${CUSTOMER}/campaignConversionGoals/${id}~${category}~${origin}`};}));
 const target=C.resource(f.binding,ASSET,{strategyRef:'strategy:fictitious',stage:'qualified_lead',campaignIds:ids}),plan=P.buildClinicaclickGoalPolicyPlan({account:target.account,snapshot:f.state.snapshot});P.assertSafePlanOperations(target.account,plan);
 assert.equal(plan.operations.campaign_conversion_goals.length,2000);assert.throws(()=>C.assertResponseBudget(plan,target,randomUUID()),{code:'action_plan_conflict'});
 await assert.rejects(f.execute('prepare',{strategyRef:'strategy:fictitious',stage:'qualified_lead',campaignIds:ids,expectedDigest:plan.plan_digest}),{code:'action_plan_conflict'});
 assert.equal(f.state.writes,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM google_goal_policy_plans').get().n,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM google_goal_policy_locks').get().n,0);
});
test('admitted final status bound includes longest new goal, all phases and validate envelope',async t=>{
 const f=setup(t),target=C.resource(f.binding,ASSET,{strategyRef:'strategy:fictitious',stage:'qualified_lead',campaignIds:['10']}),plan=P.buildClinicaclickGoalPolicyPlan({account:target.account,snapshot:f.state.snapshot}),planId=randomUUID();
 const maximum=C.assertResponseBudget(plan,target,planId);assert(maximum<=32768);const p=(await f.prepare()).data,a=(await f.execute('apply',f.phase(p.planId,'goal'))).data;
 assert(Buffer.byteLength(JSON.stringify({...a,validated:true}))<=maximum);assert.equal(f.state.writes,1);
});

test('new goal ACK must obey the same 20-digit positive resource bound used before INTENT',async t=>{
 const f=setup(t),p=(await f.prepare()).data;
 assert.throws(()=>C.result({results:[{resourceName:GOAL+'\n'}]},'goal',[{create:{}}],{customerId:CUSTOMER},false),{code:'provider_failed'});
 f.state.rawMutation={results:[{resourceName:`customers/${CUSTOMER}/customConversionGoals/${'9'.repeat(21)}`}]};
 await assert.rejects(f.execute('apply',f.phase(p.planId,'goal')),{code:'provider_failed'});const s=(await f.execute('status',{planId:p.planId})).data;
 assert.equal(s.phases[0].state,'unknown');assert.equal(s.phases[0].resources.length,0);assert.equal(f.state.writes,1);
});
module.exports={setup,CUSTOMER,ASSET,GOAL};
