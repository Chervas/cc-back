'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{randomUUID}=require('node:crypto');
const {Sequelize,DataTypes:D}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {createGoogleAdsGoalPolicyJournal,hash,MAX_HISTORY}=require('../../services/googleAdsGoalPolicyJournal.service');
const {createGoalPolicyAuthority,createGoogleAdsGoalPolicyManagedExecutor}=require('../../services/googleAdsGoalPolicyManagedExecution.service');
const {createGoogleAdsBroker}=require('../../services/googleAdsBroker.service');
const {goalPolicyFailureSummary}=require('../../lib/googleAdsGoalPolicyFailure');
const C=require('../../../services/integrations-broker/src/google-goal-policy-write-contract');
const P=require('../../../services/integrations-broker/src/google-goal-policy-plan');
const root=path.resolve(__dirname,'../../..');
function load(relative,deps){const module={exports:{}},filename=path.join(root,relative);vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,
 require:n=>{if(n==='../lib/googleAdsGoalPolicyFailure')return{goalPolicyFailureSummary};if(Object.hasOwn(deps,n))return deps[n];if(n.startsWith('node:'))return require(n);throw Error('UNEXPECTED_GOAL_SQL_IMPORT:'+n);},Buffer,URL,Date,Map,Set,console,structuredClone,process:{env:{}}},{filename});return module.exports;}
const customer='1234567890',GOAL=`customers/${customer}/customConversionGoals/88`,ids={lead:'1',contact:'2',qualified_lead:'3',schedule:'4',purchase:'5'};
function account(){return P.normalizeConfiguredAccounts([{customer_id:customer,strategy_ref:'strategy:fictitious',campaign_ids:['10'],canonical_action_ids:ids,bidding_action_key:'qualified_lead'}])[0];}
function response(planId,commands,through){const phases=C.PHASES.map((phase,i)=>{const ack=i<=through;const requestId=ack?commands[phase].requestId:null;const resources=ack?[phase==='goal'?GOAL:phase==='campaign_config'?`customers/${customer}/conversionGoalCampaignConfigs/10`:`customers/${customer}/campaignConversionGoals/10~SUBMIT_LEAD_FORM~WEBSITE`]:[];
 const p={phase,state:ack?'ack':'pending',requestId,receiptSha256:null,resources,knownMutationCount:ack?1:0,attemptedMutationCount:ack?1:0};if(ack)p.receiptSha256=C.hash({planId,phase,requestId,resources,knownMutationCount:1,attemptedMutationCount:1});return p;});
 return{planId,state:through===2?'complete':through<0?'prepared':'active',expiresAt:Date.now()+300000,planDigest:'a'.repeat(64),phases};}
async function main(){return withIsolatedCampaignMysql(async({sql,models,report})=>{
 assert.match(report.mysql,/^8\.(?:0|4)\./);if(process.env.GOAL_POLICY_MYSQL_EXPECTED_VERSION)assert.equal(report.mysql,process.env.GOAL_POLICY_MYSQL_EXPECTED_VERSION);const q=sql.getQueryInterface(),ddl=[];
 const wrapped={createTable:async(...args)=>{const value=await q.createTable(...args);const[w]=await sql.query('SHOW WARNINGS');assert.equal(w.length,0);ddl.push({operation:'CREATE_TABLE',warnings:0});return value;},addIndex:async(...args)=>{const value=await q.addIndex(...args);const[w]=await sql.query('SHOW WARNINGS');assert.equal(w.length,0);ddl.push({operation:'ADD_INDEX',warnings:0});return value;}};
 await require('../../../migrations/20261030090000-create-google-ads-goal-policy-journals').up(wrapped,D);assert.equal(ddl.length,4);
 models.GoogleAdsGoalPolicyJournal=require('../../../models/googleadsgoalpolicyjournal')(sql,D);
 models.CampaignOptimizationPolicy=require('../../../models/campaignoptimizationpolicy')(sql,D);
 models.IntakeConfig=sql.define('GoalFixtureIntake',{id:{type:D.INTEGER,primaryKey:true},config:D.JSON},{tableName:'IntakeConfigs',timestamps:false});
 models.CampaignRequest=sql.define('GoalFixtureRequest',{id:{type:D.INTEGER,primaryKey:true},campaign_id:D.INTEGER,solicitud:D.JSON,updated_at:D.DATE(3)},{tableName:'CampaignRequests',timestamps:false});
 models.ManagedCampaign=sql.define('GoalFixtureManaged',{id:{type:D.STRING(36),primaryKey:true},status:D.STRING(30),version:D.INTEGER,provider:D.STRING(30),family:D.STRING(30),management_mode:D.STRING(30),operation_mode:D.STRING(30),approved_by_user_id:D.INTEGER,approved_at:D.DATE(3)},{tableName:'ManagedCampaigns',timestamps:false});
 await models.CampaignOptimizationPolicy.sync();await models.IntakeConfig.sync();await models.CampaignRequest.sync();await models.ManagedCampaign.sync();
 const managed=load('src/services/managedCampaignOptimizationPolicy.service.js',{'../../models':models,'./campaignOptimizationLifecycle.service':{MODES:{GUIDED_IMPROVEMENT:'guided_improvement'},STAGES:{QUALIFIED_LEAD:'qualified_lead'}},'./googleAdsClinicaclickGoalPolicy.service':P});
 const guided=load('src/services/guidedCampaignOptimizationPolicy.service.js',{'../../models':models,sequelize:{Op:Sequelize.Op},'./campaignOptimizationLifecycle.service':{MODES:{GUIDED_IMPROVEMENT:'guided_improvement'},STAGES:{QUALIFIED_LEAD:'qualified_lead'}},'./googleAdsClinicaclickGoalPolicy.service':P,'./managedCampaignOptimizationPolicy.service':managed});
 const Journal=models.GoogleAdsGoalPolicyJournal,authority=createGoalPolicyAuthority({models,managed,guided});
 let n=0;async function fixture({mode='guided_improvement'}={}){n++;const leaseToken=randomUUID(),a=account(),id=n,managedId=mode==='managed_service'?randomUUID():null;
  if(managedId)await models.ManagedCampaign.create({id:managedId,status:'launching',version:1,provider:'google_ads',family:'google_search',management_mode:'autopilot',operation_mode:'managed',approved_by_user_id:7,approved_at:new Date()});
  await models.IntakeConfig.create({id,config:{google_ads:{goal_policy:{accounts:[a]}}}});
  const auth={version:1,accepted:true,accepted_at:'2026-10-01T00:00:00.000Z',accepted_by_user_id:7,scopes:['landing_publish','campaign_destination','conversion_goal']};
  const payload={kind:'marketing_strategy',status:'active',mode_snapshot:'guided_improvement',mode_contract:{mode:'guided_improvement',manage_conversion_goals:true,authorization:auth},external_targets:[{campaigns:[{provider:'google_ads',customer_id:customer,campaign_id:'10'}]}]};
  await models.CampaignRequest.create({id,campaign_id:id,solicitud:payload,updated_at:new Date()});
  await models.CampaignOptimizationPolicy.create({id,scopeType:'group',scopeId:5,clinicaId:null,grupoClinicaId:5,mode,strategyId:managedId?null:id,managedCampaignId:managedId,customerIds:[customer],campaignIds:['10'],lifecycleState:{stage:'qualified_lead',execution_lease:{token:leaseToken,expires_at:new Date(Date.now()+600000).toISOString()}},thresholds:{},status:'paused',version:1});
  const input={policyId:id,intakeConfigId:id,actorUserId:7,leaseToken,account:a,scope:{assignment_scope:'group',group_id:5},planDigest:'a'.repeat(64)};
  const repo=createGoogleAdsGoalPolicyJournal({models,verifyAuthority:authority,persistGoalOwnership:managed.persistGoalOwnership});return{repo,input,token:await repo.context(input),id,leaseToken,a,managedId};
 }
 async function releaseAll(){await Journal.update({active_lock_key:null},{where:{}});} // TEST-ONLY cleanup of synthetic rows; never a product recovery API.
 // 1: Complete own SQL flow, callback ownership and primary readback.
 const f=await fixture(),j=await f.repo.begin(f.token),prep={strategyRef:f.a.strategy_ref,stage:f.a.policy_stage,campaignIds:f.a.campaign_ids,expectedDigest:'a'.repeat(64)};
 await f.repo.intent(f.token,j.id,'prepare',prep);await f.repo.acknowledged(f.token,j.id,'prepare',response(j.id,j.commands,-1));
 await f.repo.intent(f.token,j.id,'goal',{planId:j.id});const goal=response(j.id,j.commands,0);await f.repo.acknowledged(f.token,j.id,'goal',goal);
 const expected={planId:j.id,customerId:customer,goalResourceName:GOAL,goalAckSha256:goal.phases[0].receiptSha256,mandateSha256:j.mandateSha256};
 const proof=await f.repo.ownership(f.token,j.id,expected);assert.equal(proof.commitState,'KNOWN_COMMITTED');assert.deepEqual(proof.readBack,expected);
 const intake=await models.IntakeConfig.findByPk(f.id,{raw:true});assert.equal(intake.config.google_ads.goal_policy.accounts[0].owned_custom_goal_resource_name,GOAL);
 for(const [i,key]of ['campaign_config','campaign_goals'].entries()){await f.repo.intent(f.token,j.id,key,{planId:j.id});await f.repo.acknowledged(f.token,j.id,key,response(j.id,j.commands,i+1));}
 await f.repo.complete(f.token,j.id);assert.equal((await Journal.findByPk(j.id)).active_lock_key,null);report.checks.push('own_commit_primary_readback_and_complete');
 // 2: Row lock and unique customer lock serialize actual concurrent transactions.
 const c=await fixture(),attempts=await Promise.allSettled([c.repo.begin(c.token),c.repo.begin(c.token)]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(attempts.filter(x=>x.status==='rejected').length,1);await releaseAll();report.checks.push('concurrent_begin_one_durable_owner');
 // 3: UNKNOWN survives fresh repository/new context and cannot be replayed.
 const u=await fixture(),uj=await u.repo.begin(u.token);await u.repo.intent(u.token,uj.id,'prepare',prep);await u.repo.uncertain(uj.id,'prepare');
 await assert.rejects(u.repo.intent(u.token,uj.id,'prepare',prep),e=>e.code==='GOAL_POLICY_JOURNAL_OUTCOME_UNKNOWN');const reopened=createGoogleAdsGoalPolicyJournal({models,verifyAuthority:authority,persistGoalOwnership:managed.persistGoalOwnership});const freshToken=await reopened.context(u.input);await assert.rejects(reopened.begin(freshToken),e=>e.code==='GOAL_POLICY_JOURNAL_UNRESOLVED');assert.equal((await Journal.findByPk(uj.id)).journal.commands.prepare.state,'unknown');await releaseAll();report.checks.push('unknown_no_replay_or_new_uuid_takeover');
 // 4: Real COMMIT then injected local ACK loss preserves intent and prevents dispatch.
 const x=await fixture(),xj=await x.repo.begin(x.token),transaction=sql.transaction.bind(sql);let lost=true;
 sql.transaction=async callback=>{const result=await transaction(callback);if(lost){lost=false;throw Error('FICTITIOUS_COMMIT_ACK_LOST');}return result;};
 await assert.rejects(x.repo.intent(x.token,xj.id,'prepare',prep),e=>e.code==='GOAL_POLICY_LOCAL_COMMIT_UNKNOWN');sql.transaction=transaction;
 assert.equal((await Journal.findByPk(xj.id)).journal.commands.prepare.state,'intent');await assert.rejects(x.repo.intent(x.token,xj.id,'prepare',prep));await releaseAll();report.checks.push('actual_commit_local_lost_ack_no_replay');
 // 5: Policy version and lease changes reject before any journal dispatch.
 const d=await fixture(),dj=await d.repo.begin(d.token);await (await models.CampaignOptimizationPolicy.findByPk(d.id)).update({version:2});await assert.rejects(d.repo.intent(d.token,dj.id,'prepare',prep),e=>e.code==='GOAL_POLICY_JOURNAL_AUTHORITY_CHANGED');await releaseAll();report.checks.push('version_lease_fence');
 // 6: Bounded retained history has no TTL deletion or silent truncation.
 const h=await fixture(),template=(await Journal.findByPk(j.id,{raw:true}));await Journal.destroy({where:{}});for(let i=0;i<MAX_HISTORY;i++)await Journal.create({...template,id:randomUUID(),policy_id:h.id,intake_config_id:h.id,active_lock_key:null,state:'complete'});
 await assert.rejects(h.repo.begin(h.token),e=>e.code==='GOAL_POLICY_JOURNAL_FULL');assert.equal(await Journal.count(),MAX_HISTORY);report.checks.push('history_full_before_dispatch');
 await Journal.destroy({where:{}});

 // 7: Genuine stale guided lifecycle writer on real SQL drops a JSON sibling;
 // the dedicated unresolved command row remains byte-identical.
 const g=await fixture(),gj=await g.repo.begin(g.token);await g.repo.intent(g.token,gj.id,'prepare',prep);await g.repo.uncertain(gj.id,'prepare');
 const durableBefore=hash((await Journal.findByPk(gj.id,{raw:true})).journal),policyInstance=await models.CampaignOptimizationPolicy.findByPk(g.id);
 await guided.applyGuidedCampaignGoalPolicy({provisioning:{provisioned:true,policy:policyInstance,intakeConfig:await models.IntakeConfig.findByPk(g.id),plan:{authorization:{accepted_by_user_id:7},scope:{providerScope:g.input.scope},configured_accounts:[g.a]}},actorUserId:7,finalizePolicy:false,
  dependencies:{previewGoalPolicy:async()=>({ready:true,digest:'a'.repeat(64)}),applyGoalPolicy:async()=>{
   const fresh=await models.CampaignOptimizationPolicy.findByPk(g.id);await fresh.update({lifecycleState:{...fresh.lifecycleState,goal_policy_journal:{state:'unknown',requestId:randomUUID()}},version:fresh.version+1});
   return{outcome:'applied',verification:{healthy:true}};
  }}});
 assert.equal((await models.CampaignOptimizationPolicy.findByPk(g.id)).lifecycleState.goal_policy_journal,undefined);
 assert.equal(hash((await Journal.findByPk(gj.id,{raw:true})).journal),durableBefore);await releaseAll();report.checks.push('genuine_stale_writer_cannot_erase_dedicated_unknown');

 // 8: Genuine account/opaque Scope/API/ownership callback drives all typed phases;
 // the provider transport is fictional and never reads the application DB.
 await Journal.destroy({where:{}});const e=await fixture();
 const originalTest=fs.readFileSync(path.join(root,'src/scripts/tests/google_ads_clinicaclick_goal_policy.test.js'),'utf8');
 const originalBody=originalTest.slice(0,originalTest.lastIndexOf('\nmain().catch'));
 const fixtureModule={exports:{}};vm.runInNewContext(originalBody+'\nmodule.exports={baseSnapshot};',{module:fixtureModule,exports:fixtureModule.exports,
  require:n=>n==='../../services/googleAdsClinicaclickGoalPolicy.service'?P:n==='../../services/googleLegacyCredentials.service'?{createGoogleLegacyCredentials:()=>({})}:require(n),Buffer,Date,Map,Set,console},{filename:'original-fictitious-plan-fixture.js'});
 const snap=JSON.parse(JSON.stringify(fixtureModule.exports.baseSnapshot()).replaceAll('1851215478',customer));
 snap.campaign_configs=[{...snap.campaign_configs[0],campaign_id:'10',resource_name:`customers/${customer}/conversionGoalCampaignConfigs/10`,campaign_resource_name:`customers/${customer}/campaigns/10`}];
 snap.campaign_conversion_goals=[{...snap.campaign_conversion_goals[0],campaign_id:'10',resource_name:`customers/${customer}/campaignConversionGoals/10~SUBMIT_LEAD_FORM~WEBSITE`}];
 const actualPlan=P.buildClinicaclickGoalPolicyPlan({account:e.a,snapshot:snap});P.assertSafePlanOperations(e.a,actualPlan);
 const scoped=require('./fixtures/google_ads_broker_scope.fixture').scopeFixture(),commands={},observed=[],wirePayloads=[];let planId,planDigest;
 const broker=createGoogleAdsBroker({...scoped.options,client:{execute:()=>{throw Error('READ_FALLBACK_FORBIDDEN');}},goalPolicyEnabled:()=>true,goalPolicyClient:{execute:async command=>{
  let value;if(command.operation===C.OPERATIONS.prepare){planId=command.requestId;planDigest=command.payload.expectedDigest;value=response(planId,commands,-1);}else{const phase=command.payload.phase;commands[phase]={requestId:command.requestId};value=response(planId,commands,C.PHASES.indexOf(phase));}
  value.planDigest=planDigest;wirePayloads.push(structuredClone(command));observed.push(command.operation);return{requestId:command.requestId,data:value};
 }}});
 const runtime={deliveryMode:'broker',customerId:customer,account:scoped.mapping,brokerContext:await broker.prepare(scoped.mapping),broker};
 const execute=createGoogleAdsGoalPolicyManagedExecutor({models,managed,guided,enabled:()=>true}),digest='b'.repeat(64);
 const result=await execute.execute({runtime,scope:e.input.scope,configuredAccounts:[e.a],expectedDigest:digest,confirmExternalMutation:true,
  context:{policyId:e.id,intakeConfigId:e.id,actorUserId:7,leaseToken:e.leaseToken},previewGoalPolicy:async()=>({ready:true,digest,accounts:[{plan:actualPlan}]})});
 assert.equal(result.verification.healthy,true);assert.equal(result.external_mutation_count,3);assert.equal(observed.length,4);
 const final=await Journal.findByPk(result.goal_policy_journal_id,{raw:true});assert.equal(final.state,'complete');assert.equal(final.active_lock_key,null);assert.equal(final.journal.ownership.goalResourceName,GOAL);
 for(const command of wirePayloads){const key=command.operation===C.OPERATIONS.prepare?'prepare':command.payload.phase;assert.equal(final.journal.commands[key].payloadSha256,hash(command.payload));}
 report.checks.push('genuine_scope_api_repository_ownership_three_phase_execution');

 // 9: Another writer's ownership cannot be silently overwritten by our callback.
 const o=await fixture(),oj=await o.repo.begin(o.token);await o.repo.intent(o.token,oj.id,'prepare',prep);await o.repo.acknowledged(o.token,oj.id,'prepare',response(oj.id,oj.commands,-1));
 await o.repo.intent(o.token,oj.id,'goal',{planId:oj.id});const oa=response(oj.id,oj.commands,0);await o.repo.acknowledged(o.token,oj.id,'goal',oa);
 const other=await models.IntakeConfig.findByPk(o.id),changed=structuredClone(other.config);changed.google_ads.goal_policy.accounts[0].owned_custom_goal_resource_name=`customers/${customer}/customConversionGoals/99`;await other.update({config:changed});
 await assert.rejects(o.repo.ownership(o.token,oj.id,{planId:oj.id,customerId:customer,goalResourceName:GOAL,goalAckSha256:oa.phases[0].receiptSha256,mandateSha256:oj.mandateSha256}),e=>e.code==='GOAL_POLICY_JOURNAL_AUTHORITY_CHANGED');
 assert.equal((await models.IntakeConfig.findByPk(o.id)).config.google_ads.goal_policy.accounts[0].owned_custom_goal_resource_name,`customers/${customer}/customConversionGoals/99`);await releaseAll();report.checks.push('foreign_ownership_preserved_before_commit');
 // 10: A native fence changes policy during its await; revalidation after it
 // prevents even a typed transport command from being sent.
 const race=await fixture(),before=observed.length;
 await assert.rejects(execute.execute({runtime,scope:race.input.scope,configuredAccounts:[race.a],expectedDigest:digest,confirmExternalMutation:true,
  context:{policyId:race.id,intakeConfigId:race.id,actorUserId:7,leaseToken:race.leaseToken},previewGoalPolicy:async()=>({ready:true,digest,accounts:[{plan:actualPlan}]}),beforeExternalMutation:async()=>{
   const row=await models.CampaignOptimizationPolicy.findByPk(race.id);await row.update({version:row.version+1});
  }}),e=>e.code==='GOAL_POLICY_MANUAL_RECOVERY_REQUIRED'&&e.retryable===false);assert.equal(observed.length,before);await releaseAll();report.checks.push('post_native_fence_version_change_zero_transport');
 // 11: Independent CLOSED gate flip during the await also prevents dispatch.
 const gate=await fixture();let open=true;const gated=createGoogleAdsGoalPolicyManagedExecutor({models,managed,guided,enabled:()=>open});
 await assert.rejects(gated.execute({runtime,scope:gate.input.scope,configuredAccounts:[gate.a],expectedDigest:digest,confirmExternalMutation:true,
  context:{policyId:gate.id,intakeConfigId:gate.id,actorUserId:7,leaseToken:gate.leaseToken},previewGoalPolicy:async()=>({ready:true,digest,accounts:[{plan:actualPlan}]}),beforeExternalMutation:async()=>{open=false;}}),e=>e.code==='GOAL_POLICY_MANUAL_RECOVERY_REQUIRED');assert.equal(observed.length,before);await releaseAll();report.checks.push('gate_change_zero_transport');

 // 12: Ownership+marker are one real transaction: a journal write failure rolls
 // back the genuine persistGoalOwnership update and produces no proof.
 const rb=await fixture(),rj=await rb.repo.begin(rb.token);await rb.repo.intent(rb.token,rj.id,'prepare',prep);await rb.repo.acknowledged(rb.token,rj.id,'prepare',response(rj.id,rj.commands,-1));await rb.repo.intent(rb.token,rj.id,'goal',{planId:rj.id});const ra=response(rj.id,rj.commands,0);await rb.repo.acknowledged(rb.token,rj.id,'goal',ra);
 const re={planId:rj.id,customerId:customer,goalResourceName:GOAL,goalAckSha256:ra.phases[0].receiptSha256,mandateSha256:rj.mandateSha256},update=Journal.update.bind(Journal);let rejectWrite=true;
 Journal.update=async(...args)=>{if(rejectWrite){rejectWrite=false;throw Error('FICTITIOUS_JOURNAL_WRITE_FAILURE');}return update(...args);};
 await assert.rejects(rb.repo.ownership(rb.token,rj.id,re));Journal.update=update;
 assert.equal((await models.IntakeConfig.findByPk(rb.id)).config.google_ads.goal_policy.accounts[0].owned_custom_goal_resource_name,null);assert.equal((await Journal.findByPk(rj.id)).journal.ownership,null);await releaseAll();report.checks.push('ownership_and_marker_atomic_rollback_no_proof');
 // 13: Actual ownership COMMIT with a locally lost ACK never returns a proof or
 // dispatches configuration; a future explicit inspection sees the marker.
 const oc=await fixture(),cj=await oc.repo.begin(oc.token);await oc.repo.intent(oc.token,cj.id,'prepare',prep);await oc.repo.acknowledged(oc.token,cj.id,'prepare',response(cj.id,cj.commands,-1));await oc.repo.intent(oc.token,cj.id,'goal',{planId:cj.id});const ca=response(cj.id,cj.commands,0);await oc.repo.acknowledged(oc.token,cj.id,'goal',ca);
 let loseOwnershipCommit=true;sql.transaction=async callback=>{const result=await transaction(callback);if(loseOwnershipCommit){loseOwnershipCommit=false;throw Error('FICTITIOUS_OWNERSHIP_COMMIT_ACK_LOST');}return result;};
 await assert.rejects(oc.repo.ownership(oc.token,cj.id,{planId:cj.id,customerId:customer,goalResourceName:GOAL,goalAckSha256:ca.phases[0].receiptSha256,mandateSha256:cj.mandateSha256}),e=>e.code==='GOAL_POLICY_LOCAL_COMMIT_UNKNOWN');sql.transaction=transaction;
 assert.equal((await models.IntakeConfig.findByPk(oc.id)).config.google_ads.goal_policy.accounts[0].owned_custom_goal_resource_name,GOAL);assert((await Journal.findByPk(cj.id)).journal.ownership);await assert.rejects(oc.repo.intent(oc.token,cj.id,'campaign_config',{planId:cj.id}));await releaseAll();report.checks.push('ownership_commit_lost_ack_no_proof_no_advance');

 // 14: The managed-service path reuses current admin approval, not the guided
 // authorization. A revoked approval stops before transport.
 const m=await fixture({mode:'managed_service'}),managedBefore=observed.length;
 const mr=await execute.execute({runtime,scope:m.input.scope,configuredAccounts:[m.a],expectedDigest:digest,confirmExternalMutation:true,
  context:{policyId:m.id,intakeConfigId:m.id,actorUserId:7,leaseToken:m.leaseToken},previewGoalPolicy:async()=>({ready:true,digest,accounts:[{plan:actualPlan}]})});
 assert.equal(mr.verification.healthy,true);assert.equal(observed.length-managedBefore,4);
 const revoked=await fixture({mode:'managed_service'}),transportBefore=observed.length;
 await (await models.ManagedCampaign.findByPk(revoked.managedId)).update({approved_by_user_id:null,approved_at:null});
 await assert.rejects(execute.execute({runtime,scope:revoked.input.scope,configuredAccounts:[revoked.a],expectedDigest:digest,confirmExternalMutation:true,
  context:{policyId:revoked.id,intakeConfigId:revoked.id,actorUserId:7,leaseToken:revoked.leaseToken},previewGoalPolicy:async()=>({ready:true,digest,accounts:[{plan:actualPlan}]})}));assert.equal(observed.length,transportBefore);report.checks.push('managed_approval_genuine_path_and_revocation');

 // 15: A real typed broker ACK is retained BEFORE local ACK persistence fails.
 const ackfail=await fixture(),updatesBeforeAckFailure=Journal.update.bind(Journal);let rejectGoalAck=true;
 Journal.update=async(patch,...rest)=>{if(rejectGoalAck&&patch.journal?.commands?.goal?.state==='ack'){rejectGoalAck=false;throw Error('FICTIONAL_GOAL_ACK_WRITE_DOWN');}return updatesBeforeAckFailure(patch,...rest);};
 const args=f=>({runtime,scope:f.input.scope,configuredAccounts:[f.a],expectedDigest:digest,confirmExternalMutation:true,context:{policyId:f.id,intakeConfigId:f.id,actorUserId:7,leaseToken:f.leaseToken},previewGoalPolicy:async()=>({ready:true,digest,accounts:[{plan:actualPlan}]})});
 let ackFailure;try{await execute.execute(args(ackfail));}catch(error){ackFailure=error;}finally{Journal.update=updatesBeforeAckFailure;}
 assert.equal(ackFailure.retryable,false);assert.equal(ackFailure.goalPolicyOutcome.outcome,'ACK');assert.equal(ackFailure.goalPolicyOutcome.knownMutationCount,1);assert.equal(ackFailure.goalPolicyOutcome.ownGoalResourceName,GOAL);
 const ackFailedRow=await Journal.findOne({where:{policy_id:ackfail.id},raw:true});assert.equal(ackFailedRow.journal.commands.goal.state,'unknown');assert.equal(ackFailedRow.journal.commands.goal.outcome.outcome,'ACK');assert.equal(ackFailedRow.journal.ownership,null);
 const callsBeforeRetry=observed.length;await assert.rejects(execute.execute(args(ackfail)));assert.equal(observed.length,callsBeforeRetry);await releaseAll();report.checks.push('typed_ack_preserved_when_local_ack_write_fails_no_replay');
 // 16: SQL COMMIT really applies ACK, then its LOCAL acknowledgement is lost.
 const lostAck=await fixture();let loseGoalAckCommit=false;const beforeLostUpdate=Journal.update.bind(Journal);
 Journal.update=async(patch,...rest)=>{const value=await beforeLostUpdate(patch,...rest);if(patch.journal?.commands?.goal?.state==='ack')loseGoalAckCommit=true;return value;};
 sql.transaction=async callback=>{const value=await transaction(callback);if(loseGoalAckCommit){loseGoalAckCommit=false;throw Error('FICTIONAL_GOAL_ACK_COMMIT_RESPONSE_LOST');}return value;};
 let lostError;try{await execute.execute(args(lostAck));}catch(error){lostError=error;}finally{Journal.update=beforeLostUpdate;sql.transaction=transaction;}
 assert.equal(lostError.goalPolicyOutcome.outcome,'ACK');assert.equal(lostError.goalPolicyOutcome.knownMutationCount,1);assert.equal(lostError.goalPolicyOutcome.ownGoalResourceName,GOAL);
 const committedAck=await Journal.findOne({where:{policy_id:lostAck.id},raw:true});assert.equal(committedAck.journal.commands.goal.state,'ack');assert(committedAck.active_lock_key);assert.equal(committedAck.journal.ownership,null);await releaseAll();report.checks.push('actual_ack_commit_local_response_lost_preserves_ack_and_lock');
 // 17: Authority changes after the genuine typed client has RETURNED its ACK,
 // before the local acknowledged() recheck. Only safe evidence may survive.
 const afterAck=await fixture(),raceRuntime={...runtime,broker:{...runtime.broker,withGoalPolicyOwnership(callback){const local=runtime.broker.withGoalPolicyOwnership(callback);return{...local,async goalPolicy(...a){const value=await local.goalPolicy(...a);if(a[2]==='apply'&&a[3].phase==='goal'){const row=await models.CampaignOptimizationPolicy.findByPk(afterAck.id);await row.update({version:row.version+1});}return value;}};}}};
 let afterError;try{await execute.execute({...args(afterAck),runtime:raceRuntime});}catch(error){afterError=error;}
 assert.equal(afterError.goalPolicyOutcome.outcome,'ACK');assert.equal(afterError.goalPolicyOutcome.knownMutationCount,1);assert.equal(afterError.goalPolicyOutcome.ownGoalResourceName,GOAL);
 const afterRow=await Journal.findOne({where:{policy_id:afterAck.id},raw:true});assert.equal(afterRow.journal.commands.goal.outcome.outcome,'ACK');assert.equal(afterRow.journal.commands.campaign_config.state,'reserved');assert.equal(afterRow.journal.ownership,null);await releaseAll();report.checks.push('post_typed_return_authority_drift_retains_ack_no_next_phase');
 // Actual oracle is metadata only for the one additive table.
 const[columns]=await sql.query("SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,EXTRA,CHARACTER_SET_NAME,COLLATION_NAME,GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='GoogleAdsGoalPolicyJournals' ORDER BY ORDINAL_POSITION");
 const[indexes]=await sql.query("SELECT INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,SUB_PART,INDEX_TYPE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='GoogleAdsGoalPolicyJournals' ORDER BY INDEX_NAME,SEQ_IN_INDEX");
 assert.equal(columns.length,16);assert.equal(new Set(indexes.map(x=>x.INDEX_NAME)).size,4);const[tables]=await sql.query("SELECT ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='GoogleAdsGoalPolicyJournals'");const[foreignKeys]=await sql.query("SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='GoogleAdsGoalPolicyJournals' AND REFERENCED_TABLE_NAME IS NOT NULL");assert.equal(tables[0].ENGINE,'InnoDB');assert.equal(tables[0].TABLE_COLLATION,'utf8mb4_0900_ai_ci');assert.equal(foreignKeys.length,0);report.goalJournalOracle={columns,indexes,ddl,table:tables[0],foreignKeys};
 });}
main().catch(e=>{console.error(e);process.exitCode=1;});
