'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {goalPolicyFailureSummary}=require('../lib/googleAdsGoalPolicyFailure');
const {canonical}=require('../../services/integrations-broker/src/canonical');
const hash=x=>createHash('sha256').update(canonical(x)).digest('hex');
const plain=x=>x?.get?x.get({plain:true}):x;
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x)&&x.length===36;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)&&x.length===64;
const KEYS=Object.freeze(['prepare','goal','campaign_config','campaign_goals']);
const MAX_BYTES=65536,MAX_HISTORY=64;
function failure(code,id=null,packet=null){return Object.assign(Error(code),{code,retryable:false,manualRecoveryRequired:true,
 goalPolicyFailure:true,goalPolicyJournalId:id,goalPolicyOutcome:packet});}
const fail=(code,id,packet)=>{throw failure(code,id,packet);};
const bounded=value=>{if(Buffer.byteLength(canonical(value))>MAX_BYTES)fail('GOAL_POLICY_JOURNAL_FULL');return value;};
function createGoogleAdsGoalPolicyJournal({models,verifyAuthority,persistGoalOwnership,now=()=>new Date()}){
 const {sequelize,GoogleAdsGoalPolicyJournal:Journal,IntakeConfig}=models||{};
 if(typeof sequelize?.transaction!=='function'||!Journal||!IntakeConfig||typeof verifyAuthority!=='function'||typeof persistGoalOwnership!=='function')fail('GOAL_POLICY_JOURNAL_CONFIGURATION_INVALID');
 const contexts=new WeakMap();
 async function authority(context,transaction){
  const captured=contexts.get(context);if(!captured)fail('GOAL_POLICY_JOURNAL_CONTEXT_INVALID');
  const current=await verifyAuthority(captured.input,{transaction});
  if(!current||!sha(current.scopeDigest)||!sha(current.mandateDigest)||!Number.isSafeInteger(current.policyVersion)
   ||!uuid(current.leaseToken)||canonical(current)!==canonical(captured.authority))fail('GOAL_POLICY_JOURNAL_AUTHORITY_CHANGED');
  return captured;
 }
 async function tx(work,id){let completed=false;
  try{return await sequelize.transaction(async transaction=>{const result=await work(transaction);completed=true;return result;});}
  catch(error){if(completed)throw failure('GOAL_POLICY_LOCAL_COMMIT_UNKNOWN',id);throw error;}
 }
 const locked=async(id,transaction)=>{const row=await Journal.findByPk(id,{transaction,lock:transaction.LOCK.UPDATE});if(!row)fail('GOAL_POLICY_JOURNAL_MISSING',id);return row;};
 function checkRow(row,captured){const r=plain(row);if(r.policy_id!=captured.input.policyId||r.intake_config_id!=captured.input.intakeConfigId||r.customer_id!==captured.input.account.customer_id
  ||r.scope_digest!==captured.authority.scopeDigest||r.mandate_digest!==captured.authority.mandateDigest||r.policy_version!==captured.authority.policyVersion||r.lease_token!==captured.authority.leaseToken)fail('GOAL_POLICY_JOURNAL_SCOPE_CHANGED',r.id);return r;}
 async function update(row,patch,transaction){const r=plain(row);if(patch.journal)bounded(patch.journal);
  const [changed]=await Journal.update({...patch,version:Number(r.version)+1,updated_at:now()},{where:{id:r.id,version:r.version},transaction});
  if(changed!==1)fail('GOAL_POLICY_JOURNAL_CAS_CONFLICT',r.id);
 }
 return{
  async assert(context){await authority(context);return true;},
  async context(input){
   if(!input||!Number.isSafeInteger(input.policyId)||input.policyId<1||!Number.isSafeInteger(input.intakeConfigId)||input.intakeConfigId<1
    ||!input.account||!/^[0-9]{10}$/.test(input.account.customer_id||'')||!sha(input.planDigest))fail('GOAL_POLICY_JOURNAL_CONTEXT_INVALID');
   const source=structuredClone(input),a=await verifyAuthority(source,{});
   if(!a||!sha(a.scopeDigest)||!sha(a.mandateDigest)||!Number.isSafeInteger(a.policyVersion)||!uuid(a.leaseToken))fail('GOAL_POLICY_JOURNAL_AUTHORITY_INVALID');
   const token=Object.freeze({});contexts.set(token,{input:source,authority:structuredClone(a)});return token;
  },
  async begin(context){
   const id=randomUUID();return tx(async transaction=>{
    const captured=await authority(context,transaction),input=captured.input,a=captured.authority;
    const lock=hash({family:'goal_policy',customerId:input.account.customer_id});
    const active=await Journal.findOne({where:{active_lock_key:lock},transaction,lock:transaction.LOCK.UPDATE});
    if(active)fail('GOAL_POLICY_JOURNAL_UNRESOLVED',plain(active).id);
    // No TTL cleanup. A full retained history closes before any provider call.
    if(await Journal.count({where:{customer_id:input.account.customer_id},transaction})>=MAX_HISTORY)fail('GOAL_POLICY_JOURNAL_FULL');
    const commands=Object.fromEntries(KEYS.map(key=>[key,{requestId:key==='prepare'?id:randomUUID(),state:'reserved',payloadSha256:null,responseSha256:null}]));
    const journal=bounded({schema:1,commands,observed:null,ownership:null,account:input.account});
    await Journal.create({id,policy_id:input.policyId,intake_config_id:input.intakeConfigId,customer_id:input.account.customer_id,
     scope_key:hash({scope:input.scope,customerId:input.account.customer_id,strategyRef:input.account.strategy_ref,campaignIds:input.account.campaign_ids}),
     active_lock_key:lock,plan_digest:input.planDigest,scope_digest:a.scopeDigest,mandate_digest:a.mandateDigest,policy_version:a.policyVersion,lease_token:a.leaseToken,
     state:'prepared',journal,version:1,created_at:now(),updated_at:now()},{transaction});
    return{id,commands:structuredClone(commands),mandateSha256:a.mandateDigest};
   },id);
  },
  async intent(context,id,key,payload){
   if(!KEYS.includes(key))fail('GOAL_POLICY_JOURNAL_COMMAND_INVALID',id);
   return tx(async transaction=>{
    const captured=await authority(context,transaction),row=await locked(id,transaction),r=checkRow(row,captured),j=structuredClone(r.journal),command=j.commands[key];
    if(r.state==='unknown'||command.state==='intent'||command.state==='unknown')fail('GOAL_POLICY_JOURNAL_OUTCOME_UNKNOWN',id);
    if(command.state!=='reserved')fail('GOAL_POLICY_JOURNAL_ALREADY_DISPATCHED',id);
    if(key!=='prepare'){
     const previous=key==='goal'?'prepare':key==='campaign_config'?'goal':'campaign_config';
     if(j.commands[previous].state!=='ack'||key!=='goal'&&!j.ownership)fail('GOAL_POLICY_JOURNAL_PREDECESSOR_UNPROVEN',id);
    }
    const payloadSha256=hash(payload);j.commands[key]={...command,state:'intent',payloadSha256};
    await update(row,{state:'active',journal:j},transaction);return{requestId:command.requestId,payloadSha256};
   },id);
  },
  async acknowledged(context,id,key,response){
   return tx(async transaction=>{
    const captured=await authority(context,transaction),row=await locked(id,transaction),r=checkRow(row,captured),j=structuredClone(r.journal),command=j.commands[key];
    if(!command||command.state!=='intent'||response?.planId!==id||response.planDigest!==r.plan_digest)fail('GOAL_POLICY_JOURNAL_ACK_INVALID',id);
    const phase=key==='prepare'?null:response.phases?.find(p=>p.phase===key);
    if(key==='prepare'?response.state!=='prepared':phase?.state!=='ack'||phase.requestId!==command.requestId)fail('GOAL_POLICY_JOURNAL_ACK_INVALID',id);
    j.commands[key]={...command,state:'ack',responseSha256:hash(response)};j.observed=structuredClone(response);
    await update(row,{journal:j},transaction);return structuredClone(response);
   },id);
  },
  async uncertain(id,key,outcome){
   return tx(async transaction=>{
    const row=await locked(id,transaction),r=plain(row),j=structuredClone(r.journal),command=j.commands[key];
    if(!command)fail('GOAL_POLICY_JOURNAL_COMMAND_INVALID',id);
    if(command.state==='ack')return; // Never downgrade known local ACK.
    if(command.state==='intent'){j.commands[key]={...command,state:'unknown'};
     // Only the typed client's small allowlisted packet may be retained.
     if(outcome){const safe=goalPolicyFailureSummary({goalPolicyFailure:true,retryable:false,manualRecoveryRequired:true,
      code:'GOAL_POLICY_MANUAL_RECOVERY_REQUIRED',goalPolicyJournalId:id,goalPolicyOutcome:outcome});
      if(safe?.outcome)j.commands[key].outcome=safe.outcome;}
     await update(row,{state:'unknown',journal:j},transaction);
    }
   },id);
  },
  async ownership(context,id,expected){
   await tx(async transaction=>{
    const captured=await authority(context,transaction),row=await locked(id,transaction),r=checkRow(row,captured),j=structuredClone(r.journal),ack=j.observed?.phases?.[0];
    if(j.commands.goal.state!=='ack'||ack?.state!=='ack'||expected.planId!==id||expected.customerId!==r.customer_id||expected.goalResourceName!==ack.resources[0]
     ||expected.goalAckSha256!==ack.receiptSha256||expected.mandateSha256!==r.mandate_digest)fail('GOAL_POLICY_JOURNAL_OWNERSHIP_INVALID',id);
    const intake=await IntakeConfig.findByPk(r.intake_config_id,{transaction,lock:transaction.LOCK.UPDATE});if(!intake)fail('GOAL_POLICY_JOURNAL_INTAKE_MISSING',id);
    await persistGoalOwnership({intakeConfig:intake,configuredAccount:captured.input.account,
     ownership:{customer_id:r.customer_id,strategy_ref:captured.input.account.strategy_ref,custom_goal_resource_name:expected.goalResourceName},transaction,
     dependencies:{IntakeConfig,sequelize}});
    j.ownership=structuredClone(expected);await update(row,{journal:j},transaction);
   },id);
   // Both reads are after known COMMIT, outside that transaction, against primary.
   const fresh=await Journal.findByPk(id,{raw:true,useMaster:true}),intake=await IntakeConfig.findByPk(fresh.intake_config_id,{raw:true,useMaster:true});
   const stored=fresh.journal?.ownership,accounts=intake?.config?.google_ads?.goal_policy?.accounts;
   const matches=Array.isArray(accounts)?accounts.filter(a=>String(a.customer_id).replace(/\D/g,'')===expected.customerId&&a.strategy_ref===contexts.get(context)?.input.account.strategy_ref):[];
   if(canonical(stored)!==canonical(expected)||matches.length!==1||matches[0].owned_custom_goal_resource_name!==expected.goalResourceName)fail('GOAL_POLICY_JOURNAL_OWNERSHIP_READBACK_FAILED',id);
   contexts.get(context).authority.ownedGoalResourceName=expected.goalResourceName;
   await authority(context);
   return{commitState:'KNOWN_COMMITTED',commitRefSha256:hash({journalId:id,journalVersion:fresh.version,intakeConfigId:fresh.intake_config_id,ownership:stored,ownedGoal:matches[0].owned_custom_goal_resource_name}),readBack:structuredClone(expected)};
  },
  async complete(context,id){
   return tx(async transaction=>{
    const captured=await authority(context,transaction),row=await locked(id,transaction),r=checkRow(row,captured),j=r.journal;
    if(KEYS.some(k=>j.commands[k].state!=='ack')||j.observed?.state!=='complete'||!j.ownership)fail('GOAL_POLICY_JOURNAL_FINAL_UNPROVEN',id);
    await update(row,{state:'complete',active_lock_key:null},transaction);return{state:'complete',journalId:id};
   },id);
  },
  async inspect(id){const row=await Journal.findByPk(id,{raw:true,useMaster:true});if(!row)fail('GOAL_POLICY_JOURNAL_MISSING',id);return structuredClone(row);},
 };
}
module.exports={createGoogleAdsGoalPolicyJournal,failure,hash,KEYS,MAX_BYTES,MAX_HISTORY};
