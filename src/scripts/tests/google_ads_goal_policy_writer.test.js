'use strict';
const {test,after}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{randomUUID}=require('node:crypto');
const deny=()=>{throw Error('NETWORK_FORBIDDEN_IN_GOAL_WRITER_QA');};require('node:net').Socket.prototype.connect=deny;require('node:tls').connect=deny;global.fetch=deny;
const {createGoogleAdsBroker}=require('../../services/googleAdsBroker.service');
const {scopeFixture}=require('./fixtures/google_ads_broker_scope.fixture');
const C=require('../../../services/integrations-broker/src/google-goal-policy-write-contract');
const modelIndex=path.join(process.env.GOAL_POLICY_QA_DEPENDENCY_ROOT||path.resolve(__dirname,'../../..'),'models/index.js');assert.equal(require.cache[modelIndex],undefined);after(()=>assert.equal(require.cache[modelIndex],undefined));
const SHA='a'.repeat(64),GOAL='customers/1234567890/customConversionGoals/88';
function status(planId,{phase='goal',count=1,state='ack',requestId=randomUUID()}={}){
 const phases=C.PHASES.map(p=>({phase:p,state:p===phase?state:'pending',requestId:p===phase?requestId:null,receiptSha256:null,resources:p===phase&&state==='ack'?[GOAL]:[],knownMutationCount:p===phase&&state==='ack'?count:0,attemptedMutationCount:p===phase?count:0}));
 for(const p of phases)if(p.state==='ack')p.receiptSha256=C.hash({planId,phase:p.phase,requestId:p.requestId,resources:p.resources,knownMutationCount:p.knownMutationCount,attemptedMutationCount:p.attemptedMutationCount});
 return{planId,state:'active',expiresAt:Date.now()+300000,planDigest:SHA,phases};
}
function fixture(){
 const scoped=scopeFixture(),calls=[],state={enabled:true,after:null,receipt:null};
 const client={execute:async command=>{calls.push(structuredClone(command));const result=command.operation===C.OPERATIONS.prepare?{...status(command.requestId),state:'prepared',phases:C.PHASES.map(p=>({phase:p,state:'pending',requestId:null,receiptSha256:null,resources:[],knownMutationCount:0,attemptedMutationCount:0}))}:status(command.payload.planId,{requestId:command.requestId});
  await state.after?.(command,result);return{requestId:command.requestId,data:result};}};
 const broker=createGoogleAdsBroker({...scoped.options,client:{execute:deny},goalPolicyClient:client,goalPolicyEnabled:()=>state.enabled,
  confirmGoalOwnershipCommitAndReadBack:async expected=>state.receipt?state.receipt(expected):{commitState:'KNOWN_COMMITTED',commitRefSha256:'b'.repeat(64),readBack:expected}});
 return{scoped,calls,state,broker,context:()=>broker.prepare(scoped.mapping),options:()=>({requestId:randomUUID(),beforeExecute:async()=>true})};
}
test('genuine facade uses account + opaque Scope + family + payload; forged account/context send zero commands',async()=>{
 const f=fixture(),ctx=await f.context(),input={strategyRef:'strategy:fictitious',stage:'qualified_lead',campaignIds:['10'],expectedDigest:SHA};
 const p=await f.broker.goalPolicy(f.scoped.mapping,ctx,'prepare',input,f.options());assert.equal(p.state,'prepared');assert.equal(f.calls.length,1);assert.equal(f.calls[0].tenantRef,'clinic:59');assert.equal(f.calls[0].operation,C.OPERATIONS.prepare);
 await assert.rejects(f.broker.goalPolicy({...f.scoped.mapping,customerId:'9999999999'},ctx,'prepare',input,f.options()));
 await assert.rejects(f.broker.goalPolicy(f.scoped.mapping,{},'prepare',input,f.options()));assert.equal(f.calls.length,1);
});
test('ownership proof is opaque, exact commit+readback required; UNKNOWN or invented boolean cannot bind',async()=>{
 const f=fixture(),ctx=await f.context(),planId=randomUUID(),s=status(planId),beforeExecute=async()=>true;
 const proof=await f.broker.goalPolicyOwnership(f.scoped.mapping,ctx,{status:s,mandateSha256:SHA,beforeExecute});
 const payload={planId,phase:'campaign_config',expectedPreviousAckSha256:s.phases[0].receiptSha256};
 await assert.rejects(f.broker.goalPolicy(f.scoped.mapping,ctx,'apply',payload,{...f.options(),ownershipProof:{verified:true}}));assert.equal(f.calls.length,0);
 f.state.after=(_command,result)=>{result.phases[0]=s.phases[0];result.phases[1]={phase:'campaign_config',state:'ack',requestId:_command.requestId,resources:[],knownMutationCount:0,attemptedMutationCount:0};const p=result.phases[1];p.receiptSha256=C.hash({planId,phase:p.phase,requestId:p.requestId,resources:p.resources,knownMutationCount:0,attemptedMutationCount:0});};
 await f.broker.goalPolicy(f.scoped.mapping,ctx,'apply',payload,{...f.options(),ownershipProof:proof});assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.ownership.commitRefSha256,'b'.repeat(64));
 f.state.receipt=expected=>({commitState:'UNKNOWN',commitRefSha256:'b'.repeat(64),readBack:expected});await assert.rejects(f.broker.goalPolicyOwnership(f.scoped.mapping,ctx,{status:s,mandateSha256:SHA,beforeExecute}));
 f.state.receipt=expected=>({commitState:'KNOWN_COMMITTED',commitRefSha256:'b'.repeat(64),readBack:{...expected,goalResourceName:'customers/9999999999/customConversionGoals/88'}});await assert.rejects(f.broker.goalPolicyOwnership(f.scoped.mapping,ctx,{status:s,mandateSha256:SHA,beforeExecute}));
});
test('post-response revocation retains ACK/count/own-resource in safe noRetry packet without raw cause',async()=>{
 const f=fixture(),ctx=await f.context(),planId=randomUUID();f.state.after=()=>{f.scoped.state.bindings[0].state='blocked';};
 const error=await f.broker.goalPolicy(f.scoped.mapping,ctx,'apply',{planId,phase:'goal',expectedPreviousAckSha256:null},f.options()).then(()=>null,e=>e);
 assert.equal(error.code,'GOAL_POLICY_MANUAL_RECOVERY_REQUIRED');assert.equal(error.retryable,false);assert.equal(error.goalPolicyOutcome.outcome,'ACK');assert.equal(error.goalPolicyOutcome.knownMutationCount,1);assert.equal(error.goalPolicyOutcome.ownGoalResourceName,GOAL);assert.equal(error.cause,undefined);assert.equal(error.response,undefined);assert.equal(f.calls.length,1);
});
test('transport loss after dispatch is UNKNOWN and not not-sent/zero; no automatic second call',async()=>{
 const f=fixture(),ctx=await f.context();f.state.after=()=>{throw Object.assign(Error('FICTITIOUS_PRIVATE_BODY'),{config:{token:'FICTITIOUS_TOKEN'}});};
 const error=await f.broker.goalPolicy(f.scoped.mapping,ctx,'apply',{planId:randomUUID(),phase:'goal',expectedPreviousAckSha256:null},f.options()).then(()=>null,e=>e);
 assert.equal(error.goalPolicyOutcome.outcome,'UNKNOWN');assert.equal(error.goalPolicyOutcome.knownMutationCount,null);assert.equal(error.retryable,false);assert(!JSON.stringify(error).includes('FICTITIOUS'));assert.equal(f.calls.length,1);
});
test('disabled writer, late mapping change and arbitrary operation/ownership fields are closed',async()=>{
 const f=fixture(),ctx=await f.context();f.state.enabled=false;
 await assert.rejects(f.broker.goalPolicy(f.scoped.mapping,ctx,'apply',{planId:randomUUID(),phase:'goal',expectedPreviousAckSha256:null},f.options()),{code:'broker_cohort_disabled'});assert.equal(f.calls.length,0);f.state.enabled=true;
 await assert.rejects(f.broker.goalPolicy(f.scoped.mapping,ctx,'apply',{planId:randomUUID(),phase:'goal',expectedPreviousAckSha256:null,ownership:true},f.options()));
 const options=f.options();options.beforeExecute=async()=>{f.scoped.state.grants[0].status='blocked';return true;};await assert.rejects(f.broker.goalPolicy(f.scoped.mapping,ctx,'status',{planId:randomUUID()},options));assert.equal(f.calls.length,0);
});
test('no configured writer client means default facade stays closed; no local-token fallback',async()=>{
 const scoped=scopeFixture(),broker=createGoogleAdsBroker({...scoped.options,client:{execute:deny}}),ctx=await broker.prepare(scoped.mapping);
 await assert.rejects(broker.goalPolicy(scoped.mapping,ctx,'apply',{planId:randomUUID(),phase:'goal',expectedPreviousAckSha256:null},{requestId:randomUUID(),beforeExecute:async()=>true}),{code:'broker_cohort_disabled'});
});
