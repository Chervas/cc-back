'use strict';
const {createGoogleAdsGoalPolicyJournal,failure,hash}=require('./googleAdsGoalPolicyJournal.service');
const P=require('../../services/integrations-broker/src/google-goal-policy-plan');
const {goalPolicyFailureSummary}=require('../lib/googleAdsGoalPolicyFailure');
const plain=x=>x?.get?x.get({plain:true}):x;
const cp=x=>structuredClone(x);
const fail=(code,id,packet)=>{throw failure(code,id,packet);};
function createGoalPolicyAuthority({models,managed,guided,now=Date.now}){
 return async(input,{transaction}={})=>{
  const opt={...(transaction?{transaction,lock:transaction.LOCK.UPDATE}:{useMaster:true})};
  const policy=plain(await models.CampaignOptimizationPolicy.findByPk(input.policyId,opt));
  const lease=policy?.lifecycleState?.execution_lease;const leaseExpiry=Date.parse(lease?.expires_at);
  if(!policy||policy.status==='completed'||policy.status==='archived'||!lease||lease.token!==input.leaseToken||!Number.isFinite(leaseExpiry)||leaseExpiry<=now()
   ||!Array.isArray(policy.customerIds)||!policy.customerIds.includes(input.account.customer_id)
   ||!input.account.campaign_ids.every(id=>policy.campaignIds.includes(id)))fail('GOAL_POLICY_JOURNAL_LEASE_OR_SCOPE_CHANGED');
  let mandate;
  if(policy.mode==='managed_service'){
   const campaign=plain(await models.ManagedCampaign.findByPk(policy.managedCampaignId,opt));
   managed.assertManagementConsent(campaign);
   mandate={kind:'managed',campaignId:campaign.id,version:campaign.version,status:campaign.status,
    approvedBy:campaign.approved_by_user_id,approvedAt:new Date(campaign.approved_at).toISOString(),actorUserId:input.actorUserId};
  }else if(policy.mode==='guided_improvement'){
   const rows=await models.CampaignRequest.findAll({where:{campaign_id:policy.strategyId},order:[['updated_at','DESC'],['id','DESC']],limit:101,...opt});
   if(rows.length>100)fail('GOAL_POLICY_JOURNAL_AUTHORITY_BUDGET');
   const request=rows.map(plain).find(r=>r.solicitud?.kind==='marketing_strategy'),payload=request?.solicitud;
   if(!payload||String(payload.status).toLowerCase()!=='active')fail('GOAL_POLICY_JOURNAL_GUIDED_NOT_ACTIVE');
   const auth=guided.assertGuidedAuthorization(payload);guided.assertGuidedPolicyPayloadCompatible(policy,payload);
   if(auth.accepted_by_user_id!==input.actorUserId)fail('GOAL_POLICY_JOURNAL_ACTOR_CHANGED');
   mandate={kind:'guided',strategyId:policy.strategyId,requestId:request.id,authorization:auth,actorUserId:input.actorUserId};
  }else fail('GOAL_POLICY_JOURNAL_MODE_INVALID');
  // Current accepted intake defines the stage/action/campaign projection; only
  // ownership is intentionally allowed to change after its exact Goal ACK.
  const intake=plain(await models.IntakeConfig.findByPk(input.intakeConfigId,opt));
  const accounts=intake?.config?.google_ads?.goal_policy?.accounts||[];
  const selected=accounts.filter(a=>String(a.customer_id).replace(/\D/g,'')===input.account.customer_id&&a.strategy_ref===input.account.strategy_ref);
  if(selected.length!==1)fail('GOAL_POLICY_JOURNAL_ACCOUNT_CHANGED');
  const current=P.normalizeConfiguredAccounts(selected)[0],expected=cp(input.account);
  const ownedGoalResourceName=current.owned_custom_goal_resource_name;
  delete current.owned_custom_goal_resource_name;delete expected.owned_custom_goal_resource_name;
  if(P.stableStringify(current)!==P.stableStringify(expected))fail('GOAL_POLICY_JOURNAL_ACCOUNT_CHANGED');
  if(policy.scopeType==='clinic'?input.scope.clinic_id!==Number(policy.scopeId):input.scope.group_id!==Number(policy.scopeId))fail('GOAL_POLICY_JOURNAL_SCOPE_CHANGED');
  return{scopeDigest:hash({policyId:policy.id,mode:policy.mode,scopeType:policy.scopeType,scopeId:policy.scopeId,
    customers:policy.customerIds,campaigns:policy.campaignIds,account:expected,bindingDigest:input.bindingDigest||null}),mandateDigest:hash(mandate),policyVersion:Number(policy.version),leaseToken:lease.token,ownedGoalResourceName};
 };
}
function createGoogleAdsGoalPolicyManagedExecutor({models,managed,guided,enabled=()=>process.env.GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED==='true',now=Date.now}){
 const verifyAuthority=createGoalPolicyAuthority({models,managed,guided,now});
 const repository=createGoogleAdsGoalPolicyJournal({models,verifyAuthority,persistGoalOwnership:managed.persistGoalOwnership,now:()=>new Date(now())});
 return{
  async execute({runtime,scope,configuredAccounts,expectedDigest,confirmExternalMutation,context,previewGoalPolicy,beforeExternalMutation}){
   if(enabled()!==true)fail('GOAL_POLICY_BROKER_APPLY_UNAVAILABLE');
   if(runtime?.deliveryMode!=='broker'||typeof runtime.broker?.goalPolicy!=='function'||typeof runtime.broker?.goalPolicyOwnership!=='function'||typeof runtime.broker?.assert!=='function'
    ||!context||!Array.isArray(configuredAccounts)||configuredAccounts.length!==1||confirmExternalMutation!==true||!Number.isSafeInteger(context.actorUserId)||context.actorUserId<1)fail('GOAL_POLICY_JOURNAL_CONTEXT_INVALID');
   const account=P.normalizeConfiguredAccounts(configuredAccounts)[0];
   const preview=await previewGoalPolicy();
   if(preview?.ready!==true||preview.digest!==expectedDigest||preview.accounts?.length!==1||preview.accounts[0].plan?.ready!==true)fail('GOAL_POLICY_JOURNAL_PLAN_STALE');
   const plan=preview.accounts[0].plan;P.assertSafePlanOperations(account,plan);
   const bindingDigest=hash(await runtime.broker.assert(runtime.account,runtime.brokerContext));
   const input={bindingDigest,policyId:context.policyId,intakeConfigId:context.intakeConfigId,actorUserId:context.actorUserId,
    leaseToken:context.leaseToken,account,scope,planDigest:plan.plan_digest};
   const token=await repository.context(input),created=await repository.begin(token);let key='prepare',proof,ownershipReceipt,lastKnownOutcome=null;
   // API ownership is minted only by the real repository's own commit+readback.
   // It never accepts an HTTP consumer's ownership object or external live TX.
   const confirmOwnership=async expected=>{ownershipReceipt=await repository.ownership(token,created.id,expected);return ownershipReceipt;};
   const verify=async()=>{if(enabled()!==true)fail('GOAL_POLICY_BROKER_APPLY_UNAVAILABLE',created.id);
    await repository.assert(token);if(typeof beforeExternalMutation==='function')await beforeExternalMutation();
    await repository.assert(token);if(enabled()!==true)fail('GOAL_POLICY_BROKER_APPLY_UNAVAILABLE',created.id);return true;};
   const call=async(family,payload)=>{
    const wirePayload=family==='prepare'?payload:{...payload,ownership:key==='goal'?null:{...ownershipReceipt.readBack,commitRefSha256:ownershipReceipt.commitRefSha256}};
    const command=await repository.intent(token,created.id,key,wirePayload);
    const result=await runtime.broker.goalPolicy(runtime.account,runtime.brokerContext,family,payload,
     {requestId:command.requestId,beforeExecute:verify,...(proof?{ownershipProof:proof}:{})});
    // The typed client has already projected and authenticated this response.
    // Preserve the factual ACK before local SQL or authority postchecks can fail.
    if(key!=='prepare'){
     const phase=result.phases.find(p=>p.phase===key&&p.state==='ack'&&p.requestId===command.requestId);
     if(phase){const packet={phase:key,dispatched:true,outcome:'ACK',requestId:command.requestId,
      knownMutationCount:phase.knownMutationCount,attemptedMutationCount:phase.attemptedMutationCount,
      receiptSha256:phase.receiptSha256,ownGoalResourceName:result.phases[0].state==='ack'?result.phases[0].resources[0]:null};
      lastKnownOutcome=goalPolicyFailureSummary(failure('GOAL_POLICY_MANUAL_RECOVERY_REQUIRED',created.id,packet))?.outcome||null;}
    }
    await repository.acknowledged(token,created.id,key,result);return result;
   };
   try{
    // Bind this execution's persistence callback through a private local scope,
    // not through a mutation payload accepted by broker or an HTTP route.
    const local=runtime.broker.withGoalPolicyOwnership?.(confirmOwnership);
    if(!local)fail('GOAL_POLICY_JOURNAL_OWNERSHIP_ADAPTER_UNAVAILABLE',created.id);
    runtime={...runtime,broker:local};
    let observed=await call('prepare',{strategyRef:account.strategy_ref,stage:account.policy_stage,campaignIds:account.campaign_ids,expectedDigest:plan.plan_digest});
    key='goal';observed=await call('apply',{planId:created.id,phase:key,expectedPreviousAckSha256:null});
    proof=await runtime.broker.goalPolicyOwnership(runtime.account,runtime.brokerContext,{status:observed,mandateSha256:created.mandateSha256,beforeExecute:verify});
    key='campaign_config';observed=await call('apply',{planId:created.id,phase:key,expectedPreviousAckSha256:observed.phases[0].receiptSha256});
    key='campaign_goals';observed=await call('apply',{planId:created.id,phase:key,expectedPreviousAckSha256:observed.phases[1].receiptSha256});
    await repository.complete(token,created.id);
    return{outcome:plan.changed?'applied':'unchanged',external_mutation_count:observed.phases.reduce((n,p)=>n+p.knownMutationCount,0),
     created_custom_goal_resource_name:observed.phases[0].resources[0],verification:{healthy:true},goal_policy_journal_id:created.id,broker_plan_id:created.id};
   }catch(error){
    let outcome=goalPolicyFailureSummary(failure('GOAL_POLICY_MANUAL_RECOVERY_REQUIRED',created.id,error?.goalPolicyOutcome))?.outcome||lastKnownOutcome;
    if(outcome&&!outcome.ownGoalResourceName&&lastKnownOutcome?.ownGoalResourceName)outcome={...outcome,ownGoalResourceName:lastKnownOutcome.ownGoalResourceName};
    // A previous phase's factual ACK remains useful to the caller, but must not
    // be stored as the outcome of a different command.
    try{await repository.uncertain(created.id,key,outcome?.phase===key?outcome:null);}catch(_storageError){/* Preserve safe evidence even if the local store is unavailable. */}
    const safe=failure('GOAL_POLICY_MANUAL_RECOVERY_REQUIRED',created.id,outcome||null);
    safe.safeBrokerCode=typeof error?.code==='string'&&/^[A-Za-z0-9_]{1,100}$/.test(error.code)?error.code:'GOAL_POLICY_JOURNAL_FAILED';throw safe;
   }
  },
 };
}
const instances=new WeakMap();
function forModels(models){
 if(process.env.GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED!=='true')fail('GOAL_POLICY_BROKER_APPLY_UNAVAILABLE');
 if(!instances.has(models))instances.set(models,createGoogleAdsGoalPolicyManagedExecutor({models,
  managed:require('./managedCampaignOptimizationPolicy.service'),guided:require('./guidedCampaignOptimizationPolicy.service')}));
 return instances.get(models);
}
module.exports={createGoalPolicyAuthority,createGoogleAdsGoalPolicyManagedExecutor,forModels};
