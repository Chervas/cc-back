'use strict';
// First-only Owner operation body. The existing signed RPC remains separate.
const {randomUUID}=require('node:crypto'),{canonical}=require('./canonical'),{fail,BrokerError}=require('./errors');
const SAFE=new Set(['invalid_request','operation_denied','scope_denied','oauth_flow_busy','oauth_flow_interrupted','outcome_unknown','idempotency_conflict',
 'secret_unavailable','secret_version_changed','provider_failed','provider_timeout','provider_unauthorized','credential_revoked','oauth_identity_mismatch','oauth_credentials_incomplete']);
function createFirstGooglePublicationOwner({ledger,vault,verifier,now=Date.now,afterCurrentReadback=()=>{}}={}){
 if(!['preflight','getPrivateState','commitActivationIntent','consumeActivationPermit','acceptActivationReceipt','read'].every(k=>typeof ledger?.[k]==='function')
  ||!['activate','confirmActivation'].every(k=>typeof vault?.[k]==='function')||typeof verifier?.verifyAndApprove!=='function'
  ||typeof now!=='function'||typeof afterCurrentReadback!=='function')fail('invalid_request');
 const active=new Set();
 const clock=()=>{const at=now();if(!Number.isSafeInteger(at)||at<=0)fail('invalid_request');return at;};
 function existing(proof,owner){try{return ledger.getPrivateState(proof,owner);}catch(error){if(error instanceof BrokerError&&error.code==='scope_denied')return null;throw error;}}
 function usable(value){if(!value?.receipt||value.receipt.mode!=='provisioned'||value.receipt.status!=='confirmed_resource_access'||value.receipt.validUntil<=clock())fail('oauth_flow_interrupted');return value.receipt;}
 async function publish(proof,owner,selection,resource,{signal}={}){
  if(!['search_console','analytics'].includes(proof?.service))fail('operation_denied');
  if(active.size>=2||active.has(proof.attemptId))fail('oauth_flow_busy');active.add(proof.attemptId);
  try{
   if(signal!==undefined&&!(signal instanceof AbortSignal))fail('invalid_request');
   const timed=AbortSignal.timeout(8000),overall=signal?AbortSignal.any([signal,timed]):timed;
   let saved=existing(proof,owner),reconciled=false;
   if(saved?.selection&&canonical(saved.selection)!==canonical(selection))fail('idempotency_conflict');
   if(saved&&['cancelled','expired'].includes(saved.state))fail('oauth_flow_interrupted');
   if(saved?.activationIntent){
    const intent=saved.activationIntent,plan=intent.vaultPlan;
    // This is READBACK ONLY for an unknown or already confirmed effect. Never
    // call activate again after an intent exists, even when current is absent.
    const readback=await vault.confirmActivation(plan,{signal:overall});
    await afterCurrentReadback(Object.freeze({attemptId:proof.attemptId,...readback}));
    const observed=ledger.acceptActivationReceipt(proof,owner,{activationRequestId:intent.activationRequestId,...readback,status:'confirmed_current'});
    usable(observed);reconciled=true;
   }
   // Recheck the real native resource and original scope before returning any
   // reused immutable receipt. This does not reuse another credential/grant.
   await verifier.verifyAndApprove(proof,owner,selection,resource,{signal:overall});
   saved=ledger.getPrivateState(proof,owner);
   if(!saved.activationIntent){
    const pins=ledger.preflight(proof,owner,selection),requestId=randomUUID();
    if(saved.state!=='approved'||!saved.approval||saved.approval.validUntil<=clock())fail('oauth_flow_interrupted');
    // Narrow only the dispatch deadline to the immutable native approval. The
    // original proof/plan plus approval digest remain in the durable intent.
    const effectPlan={...pins.vaultPlan,expiresAt:Math.min(pins.vaultPlan.expiresAt,saved.approval.validUntil)};
    const remaining=effectPlan.expiresAt-clock();if(remaining<=0)fail('oauth_flow_interrupted');
    const effectSignal=AbortSignal.any([overall,AbortSignal.timeout(Math.min(2147483647,remaining))]);
    await vault.activate(effectPlan,()=>{
     const permit=ledger.commitActivationIntent(proof,owner,{activationRequestId:requestId});
     return ledger.consumeActivationPermit(permit,proof,owner);
    },{signal:effectSignal});
    // UpdateSecretVersionStage's acknowledgement is never the receipt.
    const readback=await vault.confirmActivation(pins.vaultPlan,{signal:overall});
    await afterCurrentReadback(Object.freeze({attemptId:proof.attemptId,...readback}));
    usable(ledger.acceptActivationReceipt(proof,owner,{activationRequestId:requestId,...readback,status:'confirmed_current'}));
   }else if(!reconciled)fail('outcome_unknown');
   const final=ledger.getPrivateState(proof,owner),plan=final.activationIntent?.vaultPlan;
   if(!plan)fail('outcome_unknown');
   // The native verification may have awaited provider I/O. Current version and
   // source cancellation are checked again immediately before the response.
   const observed=await vault.confirmActivation(plan,{signal:overall});
   const confirmed=ledger.acceptActivationReceipt(proof,owner,{activationRequestId:final.activationIntent.activationRequestId,...observed,status:'confirmed_current'});
   const receipt=usable(confirmed),fresh=usable(ledger.read(proof,owner));
   if(canonical(receipt)!==canonical(fresh))fail('idempotency_conflict');
   const result=structuredClone(receipt);if(result.resource)Object.freeze(result.resource);return Object.freeze(result);
  }catch(error){throw new BrokerError(error instanceof BrokerError&&SAFE.has(error.code)?error.code:'outcome_unknown');}
  finally{active.delete(proof.attemptId);}
 }
 return Object.freeze({publish});
}
module.exports={createFirstGooglePublicationOwner};
