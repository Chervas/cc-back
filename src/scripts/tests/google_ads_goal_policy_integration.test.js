'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{randomUUID}=require('node:crypto');
const deny=()=>{throw Error('NETWORK_FORBIDDEN_IN_GOAL_INTEGRATION_QA');};require('node:net').Socket.prototype.connect=deny;require('node:tls').connect=deny;global.fetch=deny;
const {goalPolicyFailureSummary}=require('../../../src/lib/googleAdsGoalPolicyFailure');
const {failure}=require('../../services/googleAdsGoalPolicyJournal.service');
const root=path.resolve(__dirname,'../../..');
function load(relative,deps,override){const filename=path.join(root,relative),module={exports:{}};
 vm.runInNewContext(override||fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:n=>{if(n==='../lib/googleAdsGoalPolicyFailure')return{goalPolicyFailureSummary};if(Object.hasOwn(deps,n))return deps[n];if(n.startsWith('node:'))return require(n);throw Error('UNEXPECTED_GOAL_INTEGRATION_IMPORT:'+n);},Buffer,URL,Date,Map,Set,console,structuredClone,
  process:{env:{},cwd:()=>'/fictitious'},setTimeout,clearTimeout,setInterval:deny,clearInterval},{filename});return module.exports;}
function jobs(){return load('src/services/guidedCampaignOptimizationJobs.service.js',{'../../models':{},sequelize:{Op:{}},'./jobRequests.service':{},'./guidedCampaignOptimizationPolicy.service':{},'./guidedCampaignOptimizationTransitions.service':{},'../lib/googleAdsGoalPolicyFailure':{goalPolicyFailureSummary}});}
test('genuine retained guided writer overwrites a separately committed lifecycle sibling: reason dedicated journal is required',async()=>{
 const stored={id:7,version:1,lifecycleState:{stage:'qualified_lead'}};let local=structuredClone(stored),committedJournal=false;
 const policy={get:()=>structuredClone(local),update:async patch=>{local={...local,...structuredClone(patch)};Object.assign(stored,structuredClone(patch));}};
 const service=load('src/services/guidedCampaignOptimizationPolicy.service.js',{'../../models':{},sequelize:{Op:{}},'./campaignOptimizationLifecycle.service':{MODES:{GUIDED_IMPROVEMENT:'guided_improvement'},STAGES:{QUALIFIED_LEAD:'qualified_lead'}},'./googleAdsClinicaclickGoalPolicy.service':{},'./managedCampaignOptimizationPolicy.service':{}});
 await service.applyGuidedCampaignGoalPolicy({provisioning:{provisioned:true,policy,intakeConfig:{id:9},plan:{authorization:{accepted_by_user_id:5},scope:{providerScope:{clinic_id:8}},configured_accounts:[{customer_id:'1234567890',campaign_ids:['10']}]}},actorUserId:5,finalizePolicy:false,
  dependencies:{previewGoalPolicy:async()=>({ready:true,digest:'a'.repeat(64)}),applyGoalPolicy:async()=>{
   // An independently committed adapter has a fresh SQL instance; the parent's
   // retained instance has not reloaded. This is the actual stale-update seam.
   stored.lifecycleState={...stored.lifecycleState,goal_policy_journal:{state:'unknown',requestId:randomUUID()}};committedJournal=true;
   return{outcome:'applied',verification:{healthy:true}};
  }}});
 assert.equal(committedJournal,true);assert.equal(stored.lifecycleState.goal_policy_journal,undefined);assert.equal(stored.lifecycleState.provider_application.accounts['1234567890'].status,'applied');
});
test('genuine guided dispatcher + native Scheduler settle marked Goal UNKNOWN without retry; ordinary errors retain behavior',async()=>{
 const api=jobs(),error=failure('GOAL_POLICY_MANUAL_RECOVERY_REQUIRED',randomUUID());
 error.goalPolicyOutcome={phase:'goal',dispatched:true,outcome:'UNKNOWN',requestId:randomUUID(),knownMutationCount:null,attemptedMutationCount:null,receiptSha256:null,ownGoalResourceName:null};
 error.cause={headers:{authorization:'FICTITIOUS_PRIVATE'}};
 const dependencies={Campaign:{findByPk:async()=>({id:7})},CampaignRequest:{findAll:async()=>[{solicitud:{kind:'marketing_strategy',status:'active'}}]},provision:async()=>({plan:{authorization:{accepted_by_user_id:5}}}),apply:async()=>{throw error;}};
 const result=await api.runGuidedCampaignOptimizationJob({strategy_id:7},dependencies);assert.equal(result.status,'failed');assert.equal(result.retryable,false);assert(!JSON.stringify(result).includes('FICTITIOUS'));
 const calls={waiting:0,failed:0};const scheduler=load('src/services/jobScheduler.service.js',{'../../models':{},'./jobRequests.service':{getCurrentRuntimeNamespace:()=> 'offline',shouldClaimUnscopedJobs:()=>false,markWaiting:async()=>{calls.waiting++;},markFailed:async()=>{calls.failed++;}},'./jobExecutor.service':{},'./aiRuntimeMonitoring.service':{},'../config/scheduledJobCatalog':{BACKGROUND_INTEGRATION_JOB_TYPES:[]},'../lib/gatewayJobOwnership':{isGatewayRuntime:()=>false}});
 await scheduler._settleJobResult({id:9,attempts:1,max_attempts:5},result);assert.deepEqual(calls,{waiting:0,failed:1});
 const ordinary=Object.assign(Error('ordinary'),{code:'ETIMEDOUT'});await assert.rejects(api.runGuidedCampaignOptimizationJob({strategy_id:7},{...dependencies,apply:async()=>{throw ordinary;}}),e=>e===ordinary);
});
test('safe Goal packet preserves known ACK/resource/count but never propagates arbitrary error fields',()=>{
 const error=failure('GOAL_POLICY_MANUAL_RECOVERY_REQUIRED',randomUUID(),{phase:'goal',dispatched:true,outcome:'ACK',requestId:randomUUID(),knownMutationCount:1,attemptedMutationCount:1,receiptSha256:'a'.repeat(64),ownGoalResourceName:'customers/1234567890/customConversionGoals/88',raw:'FICTITIOUS_SECRET'});error.config={secret:'FICTITIOUS_SECRET'};
 const s=goalPolicyFailureSummary(error);assert.equal(s.outcome.knownMutationCount,1);assert.equal(s.outcome.ownGoalResourceName,'customers/1234567890/customConversionGoals/88');assert(!JSON.stringify(s).includes('FICTITIOUS'));assert.equal(goalPolicyFailureSummary({retryable:false}),null);
});

test('genuine schema contract excludes the journal+ledger while CLOSED and requires exact selected migration when enabled',async()=>{
 const native=require('../../lib/securitySchemaContract'),contract=JSON.parse(fs.readFileSync(path.join(root,'ops/security/schema-contract.json'),'utf8'));
 const name='20261030090000-create-google-ads-goal-policy-journals.js',entry=contract.migrations.find(x=>x.name===name);
 assert(entry);assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root,'migrations',name))).digest('hex'),entry.sha256);
 const closed=native.effectiveContract(contract,{}),open=native.effectiveContract(contract,{GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED:'true'});
 assert.equal(closed.tables.GoogleAdsGoalPolicyJournals,undefined);assert.equal(closed.migrations.some(x=>x.name===name),false);assert(open.tables.GoogleAdsGoalPolicyJournals);assert(open.migrations.some(x=>x.name===name));
 const queries=[];await native.snapshot(async sql=>{queries.push(sql);if(sql.includes('SCHEMATA'))return[{}];return[];});assert(queries.every(sql=>! /FROM\s+`?GoogleAdsGoalPolicyJournals/.test(sql)));
});

test('configured writer is CLOSED before key reads; active fixture requires a distinct writer key and immutable configuration',async()=>{
 const {createConfiguredGoogleAdsGoalPolicyClient}=require('../../services/googleAdsBroker.service'),{generateKeyPairSync}=require('node:crypto');
 const env={},seen=[];const createClient=()=>({execute:async()=>({ok:true})});let reads=0;
 const c=createConfiguredGoogleAdsGoalPolicyClient({env,readPrivateFile:()=>{reads++;throw Error('NO_KEY_READ_WHILE_CLOSED');},createClient});assert.throws(()=>c.identity(),e=>e.code==='broker_cohort_disabled');assert.equal(reads,0);
 Object.assign(env,{GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED:'true',GOOGLE_ADS_GOAL_POLICY_BROKER_ORIGIN:'https://broker.fictitious.invalid',GOOGLE_ADS_GOAL_POLICY_BROKER_AUDIENCE:'fixture',GOOGLE_ADS_GOAL_POLICY_BROKER_KEY_ID:'writer',GOOGLE_ADS_GOAL_POLICY_BROKER_KEY_FILE:'/fixture/writer',GOOGLE_ADS_GOAL_POLICY_BROKER_CA_FILE:'/fixture/ca',GOOGLE_ADS_BROKER_KEY_ID:'reader',GOOGLE_ADS_BROKER_KEY_FILE:'/fixture/reader'});
 const writer=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}),reader=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'});
 const client=createConfiguredGoogleAdsGoalPolicyClient({env,readPrivateFile:file=>file==='/fixture/writer'?writer:file==='/fixture/reader'?reader:Buffer.from('FICTITIOUS_CA'),createClient:opts=>{seen.push(opts.origin);return createClient();}});
 assert.match(client.identity(),/^[a-f0-9]{64}$/);assert.equal((await client.execute({})).ok,true);assert.deepEqual(seen,['https://broker.fictitious.invalid']);env.GOOGLE_ADS_GOAL_POLICY_BROKER_KEY_ID='changed';assert.throws(()=>client.identity(),e=>e.code==='broker_configuration_invalid');
 const reused={...env,GOOGLE_ADS_GOAL_POLICY_BROKER_KEY_ID:'writer2'};assert.throws(()=>createConfiguredGoogleAdsGoalPolicyClient({env:reused,readPrivateFile:()=>writer,createClient}).identity(),e=>e.code==='broker_configuration_invalid');
 const same={...env,GOOGLE_ADS_GOAL_POLICY_BROKER_KEY_ID:'reader'};assert.throws(()=>createConfiguredGoogleAdsGoalPolicyClient({env:same,readPrivateFile:()=>writer,createClient}).identity(),e=>e.code==='broker_configuration_invalid');
});

test('genuine guided apply preserves marked ACK through both failing housekeeping writes and native dispatch stops retry',async()=>{
 const service=()=>load('src/services/guidedCampaignOptimizationPolicy.service.js',{'../../models':{},sequelize:{Op:{}},'./campaignOptimizationLifecycle.service':{MODES:{GUIDED_IMPROVEMENT:'guided_improvement'},STAGES:{QUALIFIED_LEAD:'qualified_lead'}},'./googleAdsClinicaclickGoalPolicy.service':{},'./managedCampaignOptimizationPolicy.service':{}});
 const original=failure('GOAL_POLICY_MANUAL_RECOVERY_REQUIRED',randomUUID(),{phase:'goal',dispatched:true,outcome:'ACK',requestId:randomUUID(),knownMutationCount:1,attemptedMutationCount:1,receiptSha256:'a'.repeat(64),ownGoalResourceName:'customers/1234567890/customConversionGoals/88'});
 async function invoke(finalizePolicy,error){let writes=0;const local={id:7,version:1,lifecycleState:{stage:'qualified_lead'}};
  const policy={get:()=>structuredClone(local),update:async patch=>{writes++;if(writes>1)throw Error('FICTIONAL_HOUSEKEEPING_STORE_DOWN');Object.assign(local,structuredClone(patch));}};
  const provisioning={provisioned:true,policy,intakeConfig:{id:9},plan:{authorization:{accepted_by_user_id:5},scope:{providerScope:{clinic_id:8}},configured_accounts:[{customer_id:'1234567890',campaign_ids:['10']}]}};
  try{await service().applyGuidedCampaignGoalPolicy({provisioning,actorUserId:5,finalizePolicy,dependencies:{acquireApplicationLease:async()=>({token:randomUUID()}),previewGoalPolicy:async()=>({ready:true,digest:'a'.repeat(64)}),applyGoalPolicy:async()=>{throw error;}}});}
  catch(caught){assert.equal(writes,finalizePolicy?3:2);throw caught;}
 }
 for(const finalize of[false,true])await assert.rejects(invoke(finalize,original),e=>e===original&&e.goalPolicyOutcome.knownMutationCount===1);
 await assert.rejects(invoke(false,Error('ordinary')),e=>e.message==='FICTIONAL_HOUSEKEEPING_STORE_DOWN');
 const result=await jobs().runGuidedCampaignOptimizationJob({strategy_id:7},{Campaign:{findByPk:async()=>({id:7})},CampaignRequest:{findAll:async()=>[{solicitud:{kind:'marketing_strategy',status:'active'}}]},provision:async()=>({plan:{authorization:{accepted_by_user_id:5}}}),apply:()=>invoke(true,original)});
 assert.equal(result.status,'failed');assert.equal(result.retryable,false);assert.equal(result.result.goal_policy_outcome.knownMutationCount,1);assert.equal(result.result.goal_policy_outcome.ownGoalResourceName,original.goalPolicyOutcome.ownGoalResourceName);
});
