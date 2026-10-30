'use strict';
const C = require('../../services/integrations-broker/src/google-goal-policy-write-contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const fail = code => { throw Object.assign(Error(code),{code}); };
const plain = x => x && Object.getPrototypeOf(x) === Object.prototype;
const exact = (x,keys) => plain(x) && Object.keys(x).sort().join(',') === keys.split(',').sort().join(',');
const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const SAFE = new Set(['scope_denied','invalid_request','operation_denied','outcome_unknown','idempotency_conflict','action_plan_conflict',
  'action_plan_expired','action_plan_busy','broker_timeout','broker_unavailable','broker_binding_invalid','broker_response_invalid',
  'broker_cohort_disabled','broker_configuration_invalid','asset_revoked','connection_blocked','credential_revoked','provider_failed','provider_timeout','audit_unavailable']);
function project(data, input, requestId, family, customerId) {
  const validating = family === 'validate';
  if (!exact(data,'planId,state,expiresAt,planDigest,phases'+(validating?',validated':'')) || !uuid(data.planId)
    || data.planId !== (family === 'prepare' ? requestId : input.planId) || !sha(data.planDigest)
    || family === 'prepare' && data.planDigest !== input.expectedDigest || !Number.isSafeInteger(data.expiresAt) || data.expiresAt < 1
    || !['prepared','active','complete'].includes(data.state) || validating && data.validated !== true
    || !Array.isArray(data.phases) || data.phases.length !== 3 || Buffer.byteLength(JSON.stringify(data)) > 32768) fail('broker_response_invalid');
  for (const [i,p] of data.phases.entries()) {
    if (!exact(p,'phase,state,requestId,receiptSha256,resources,knownMutationCount,attemptedMutationCount') || p.phase !== C.PHASES[i]
      || !['pending','ack','unknown'].includes(p.state) || !Array.isArray(p.resources) || p.resources.length > (i===0?1:i===1?200:2000)
      || !Number.isSafeInteger(p.knownMutationCount) || p.knownMutationCount < 0 || !Number.isSafeInteger(p.attemptedMutationCount)
      || p.attemptedMutationCount < p.knownMutationCount || p.attemptedMutationCount > (i===0?1:i===1?200:2000)
      || (p.state==='pending' ? p.requestId!==null || p.receiptSha256!==null || p.resources.length || p.attemptedMutationCount
        : !uuid(p.requestId) || p.state==='ack' && !sha(p.receiptSha256) || p.state==='unknown' && (p.receiptSha256!==null || p.resources.length || p.knownMutationCount))) fail('broker_response_invalid');
    const kind = i===0?'customConversionGoals/[1-9][0-9]{0,19}':i===1?'conversionGoalCampaignConfigs/[1-9][0-9]{0,19}':'campaignConversionGoals/[1-9][0-9]{0,19}~[A-Z_]+~[A-Z_]+';
    if (p.resources.some(r => typeof r!=='string' || !new RegExp(`^customers/${customerId}/${kind}$`).test(r))
      || new Set(p.resources).size!==p.resources.length || p.state==='ack' && (i===0 ? p.resources.length!==1 : p.resources.length!==p.knownMutationCount)) fail('broker_response_invalid');
  }
  for (const p of data.phases) if (p.state==='ack' && p.receiptSha256!==C.hash({planId:data.planId,phase:p.phase,requestId:p.requestId,resources:p.resources,knownMutationCount:p.knownMutationCount,attemptedMutationCount:p.attemptedMutationCount})) fail('broker_response_invalid');
  if (data.state==='complete' && data.phases.some(p=>p.state!=='ack') || family==='prepare' && data.phases.some(p=>p.state!=='pending')) fail('broker_response_invalid');
  return structuredClone(data);
}
// No HTTP endpoint, UUID generation or retry. Application code must durably own
// command IDs. The ownership callback is a trusted persistence adapter, NOT a
// consumer boolean. Without it, campaign binding remains closed.
function createGoogleAdsGoalPolicyBrokerClient({client,assertContext,confirmOwnershipCommitAndReadBack,now=Date.now,
  enabled=()=>process.env.GOOGLE_ADS_GOAL_POLICY_BROKER_ENABLED==='true'}) {
  if(typeof client?.execute!=='function'||typeof assertContext!=='function'||typeof enabled!=='function')fail('broker_configuration_invalid');
  const proofs=new WeakMap();
  async function capture(context) {
    const x=await assertContext(context);
    if(!plain(x)||x.discoveryOnly!==false||!/^clinic:[1-9][0-9]{0,9}$/.test(x.tenantRef||'')
      ||!/^connection:[A-Za-z0-9_.:-]+$/.test(x.connectionRef||'')||!/^[0-9]{10}$/.test(x.customerId||'')
      ||x.assetRef!=='ads:'+x.customerId||x.loginCustomerId!==null&&!/^[0-9]{10}$/.test(x.loginCustomerId||''))fail('broker_binding_invalid');
    return x;
  }
  return {
    async ownershipProof(context,{status,mandateSha256,beforeExecute}) {
      if(enabled()!==true)fail('broker_cohort_disabled');
      if(typeof confirmOwnershipCommitAndReadBack!=='function'||typeof beforeExecute!=='function'||!sha(mandateSha256))fail('broker_configuration_invalid');
      const captured=await capture(context),identity=canonical(captured),ack=status?.phases?.[0];
      // Reuse the strict status projector; a foreign resource can never become
      // an ownership witness even if the persistence callback is miswired.
      project(status,{planId:status?.planId},null,'status',captured.customerId);
      if(ack.state!=='ack'||await beforeExecute()!==true)fail('scope_denied');
      const expected={planId:status.planId,customerId:captured.customerId,goalResourceName:ack.resources[0],goalAckSha256:ack.receiptSha256,mandateSha256};
      const receipt=await confirmOwnershipCommitAndReadBack(structuredClone(expected));
      if(!exact(receipt,'commitState,commitRefSha256,readBack')||receipt.commitState!=='KNOWN_COMMITTED'||!sha(receipt.commitRefSha256)
        ||canonical(receipt.readBack)!==canonical(expected)||await beforeExecute()!==true||canonical(await capture(context))!==identity
        ||enabled()!==true)fail('scope_denied');
      const proof=Object.freeze({});proofs.set(proof,{identity,value:{...expected,commitRefSha256:receipt.commitRefSha256}});return proof;
    },
    async execute(context,family,input,options={}) {
      let dispatched=false,captured,result;const requestId=options?.requestId;
      try{
        if(!Object.hasOwn(C.OPERATIONS,family)||!plain(input)||Object.hasOwn(input,'ownership')||!plain(options)
          ||Object.keys(options).some(k=>!['requestId','beforeExecute','timeoutMs','ownershipProof'].includes(k))||!uuid(requestId)
          ||typeof options.beforeExecute!=='function'||!Number.isInteger(options.timeoutMs??30000)||(options.timeoutMs??30000)<1||(options.timeoutMs??30000)>30000)fail('invalid_request');
        const deadline=now()+(options.timeoutMs??30000),gate=()=>{if(enabled()!==true)fail('broker_cohort_disabled');if(now()>=deadline)fail('broker_timeout');};
        gate();captured=await capture(context);const identity=canonical(captured),payload=structuredClone(input);
        if(family==='apply'||family==='validate'){
          if(payload.phase==='goal'){if(options.ownershipProof!==undefined)fail('scope_denied');payload.ownership=null;}
          else {const proof=proofs.get(options.ownershipProof);if(!proof||proof.identity!==identity||proof.value.planId!==payload.planId)fail('scope_denied');payload.ownership=structuredClone(proof.value);}
        }
        C.validate(C.OPERATIONS[family],payload);
        const verify=async()=>{gate();if(await options.beforeExecute()!==true||canonical(await capture(context))!==identity)fail('scope_denied');gate();};
        await verify();dispatched=true;
        const response=await client.execute({requestId,operation:C.OPERATIONS[family],connectionRef:captured.connectionRef,
          tenantRef:captured.tenantRef,assetRef:captured.assetRef,payload},{timeoutMs:deadline-now()});
        if(response?.requestId!==requestId)fail('broker_response_invalid');
        result=project(response.data,payload,requestId,family,captured.customerId);
        await verify();return result;
      }catch(error){
        const code=SAFE.has(error?.code)?error.code:'google_goal_policy_broker_failed';
        if(family==='apply'&&dispatched){
          const ack=result?.phases.find(p=>p.phase===input?.phase&&p.state==='ack');
          const packet={phase:input.phase,dispatched:true,outcome:ack?'ACK':'UNKNOWN',requestId,
            knownMutationCount:ack?.knownMutationCount??null,attemptedMutationCount:ack?.attemptedMutationCount??null,
            receiptSha256:ack?.receiptSha256??null,ownGoalResourceName:result?.phases[0]?.state==='ack'?result.phases[0].resources[0]:null};
          throw Object.assign(Error('GOAL_POLICY_MANUAL_RECOVERY_REQUIRED'),{code:'GOAL_POLICY_MANUAL_RECOVERY_REQUIRED',retryable:false,
            manualRecoveryRequired:true,goalPolicyOutcome:packet,safeBrokerCode:code});
        }
        fail(code);
      }
    },
  };
}
module.exports={createGoogleAdsGoalPolicyBrokerClient,project};
