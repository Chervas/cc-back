'use strict';
// Private orchestration only: every Owner await is outside a SQL transaction.
// The original publisher supplies its existing authority/canonical/SQL hooks.
const C=require('./googleOAuthAdmissionAttempt.contract'),R=require('./googleOAuthAdmissionRecovery.contract');
const {firstAnalyticsSubjectDigest}=require('../../services/integrations-broker/src/google-property-discovery-contract');
const unavailable=()=>{throw C.problem('google_oauth_admission_attempt_unavailable',503);};
const conflict=()=>{throw C.problem('google_oauth_admission_attempt_conflict',409);};
const status=error=>error?.status??error?.httpStatus;
const safe=error=>C.problem(status(error)===401?'google_oauth_admission_session_required':status(error)===403?'google_oauth_admission_forbidden':status(error)===409?'google_oauth_admission_attempt_conflict':'google_oauth_admission_attempt_unavailable',[401,403,409].includes(status(error))?status(error):503);
const terminal=row=>R.TERMINAL.includes(row.state);
function createGoogleOAuthAdmissionRecoveryCoordinator({capture,repository,owner,claim,validateOriginal,verifyNative,commit,verifyCommitted,mayContinue,now=()=>new Date()}={}){
 if([capture,repository,claim,validateOriginal,verifyNative,commit,verifyCommitted,mayContinue,now].some(value=>typeof value!=='function')
  ||['previewIdentity','verifyPublication','observeRecovery','ackRecovery','quarantineRecovery','abortUnused'].some(name=>typeof owner?.[name]!=='function'))unavailable();
 const clock=()=>C.clock(now());
 function request(row){return Object.freeze({attemptId:row.attempt_id,scopeKey:row.scope_key,service:'analytics',clinicId:row.clinic_id,assetRef:row.asset_ref,
  bindingDigest:row.binding_digest,clinicSetDigest:row.clinic_digest,expiresAt:+row.attempt_expires_at,crmIntentId:row.crm_intent_id,
  expectedSubjectDigest:row.subject_digest,dispatchRequestId:row.dispatch_request_id});}
 function selected(row){return Object.freeze({attemptId:row.attempt_id,scopeKey:row.scope_key,service:'analytics',clinicId:row.clinic_id,assetRef:row.asset_ref});}
 const published=(row,replayed)=>Object.freeze({attemptId:row.attempt_id,scopeKey:row.scope_key,service:'analytics',authorizationConfirmed:true,connected:true,configurationPending:false,replayed});
 function identity(value,row){
  if(!C.exact(value,['attemptId','scopeKey','service','googleUserId','subjectDigest'])||value.attemptId!==row.attempt_id
   ||value.scopeKey!==row.scope_key||value.service!=='analytics'||value.subjectDigest!==firstAnalyticsSubjectDigest(value.googleUserId))conflict();
  return Object.freeze({...value});
 }
 async function acknowledge(repo,current){
  if(current.row.state!=='sql_committed'||!current.row.owner_receipt)conflict();
  let valid;try{valid=await verifyCommitted(current.row);}catch(error){if(status(error)!==409)throw error;}
  if(valid!==true)throw Object.assign(C.problem('google_oauth_admission_attempt_conflict',409),{recoveryCanonicalConflict:true});
  const receipt=R.json(current.row.owner_receipt),reply=await owner.ackRecovery(Object.freeze({...request(current.row),receiptId:receipt.receiptId,receiptDigest:current.row.owner_receipt_digest}));
  return repo.completePublished(current.fence,reply);
 }
 async function close(repo,current){
  if(current.row.state==='quarantined'||current.row.state==='closed_unused')return current;
  if(current.row.state==='sql_committed'||current.row.state==='published')conflict();
  let closing=await repo.quarantine(current.fence);
  if(closing.row.subject_digest===null){const reply=await owner.abortUnused(request(closing.row));return repo.completeUnused(closing.fence,reply);}
  const reply=await owner.quarantineRecovery(request(closing.row));
  return repo.completeQuarantine(closing.fence,reply);
 }
 async function observe(repo,current){const reply=await owner.observeRecovery(request(current.row));return repo.observe(current.fence,reply);}
 async function finishOriginal(repo,current,captured,context,replayed,update=()=>{}){
  if(current.row.state!=='remote_confirmed'||!current.row.owner_receipt||!current.row.owner_observation
    ||R.json(current.row.owner_observation).state!=='confirmed_current'
    ||R.json(current.row.owner_observation).receiptDigest!==current.row.owner_receipt_digest)unavailable();
  const receipt=R.json(current.row.owner_receipt);
  if(receipt.validUntil<=clock()||+current.row.attempt_expires_at<=clock()||+current.row.session_expires_at<=clock())conflict();
  await validateOriginal({captured,context,selection:selected(current.row),intent:current.row});
  const resource=await verifyNative({receipt,context});
  current=await repo.nativeResource(current.fence,resource);update(current);
  await validateOriginal({captured,context,selection:selected(current.row),intent:current.row});
  const committed=await commit({captured,context,selection:selected(current.row),receipt,resource:R.json(current.row.native_resource),intent:current,repository:repo});
  current=committed.intent;update(current);
  if(current?.row?.state!=='sql_committed')unavailable();
  current=await acknowledge(repo,current);update(current);
  return published(current.row,Boolean(committed.replayed||replayed));
 }
 async function publish(req,input){
  let repo,current,ownsLease=false;
  try{
   if(!C.exact(input,['attemptId','scopeKey','service','clinicId','assetRef'])||input.service!=='analytics')throw C.problem();
   const captured=await capture(req,{attemptId:input.attemptId,scopeKey:input.scopeKey,service:'analytics'}),context=C.input(captured.context);
   R.selection(context,{clinicId:input.clinicId,assetRef:input.assetRef});
   repo=repository(captured);current=await repo.prepare(context,{clinicId:input.clinicId,assetRef:input.assetRef});ownsLease=current.created===true;
   const initialState=current.row.state;
   if(current.row.state==='published'){if(await verifyCommitted(current.row)!==true)conflict();return published(current.row,true);}
   if(['quarantined','quarantine_pending','closed_unused'].includes(current.row.state))conflict();
   if(current.row.state==='sql_committed'){current=await repo.claimRecovery(current.row.attempt_id);ownsLease=true;current=await acknowledge(repo,current);return published(current.row,true);}
   if(initialState!=='prepared'){
    if(+current.row.lease_until>clock())unavailable();
    current=await repo.claimUser(context);ownsLease=true;
    current=await observe(repo,current);
    return await finishOriginal(repo,current,captured,context,true,value=>{current=value;});
   }
   if(!ownsLease){if(+current.row.lease_until>clock())unavailable();current=await repo.claimUser(context);ownsLease=true;}
   // The durable prepared row precedes even the read-only identity preview.
   const preview=identity(await owner.previewIdentity(request(current.row)),current.row);
   const claimDigest=await claim({captured,context,selection:input,identity:preview});
   current=await repo.dispatch(context,current.fence,{googleUserId:preview.googleUserId,subjectDigest:preview.subjectDigest,claimDigest});ownsLease=true;
   try{await owner.verifyPublication(request(current.row));}
   catch{current=await repo.unknown(current.fence);}
   // Current/receipt comes from authenticated readback, never a promotion ACK.
   current=await observe(repo,current);
   return await finishOriginal(repo,current,captured,context,false,value=>{current=value;});
  }catch(error){
   if(repo&&current&&!terminal(current.row)&&ownsLease){
    try{
     if([401,403,409].includes(status(error))&&!['sql_committed','published'].includes(current.row.state))await close(repo,current);
     else await repo.park(current.fence,error?.recoveryCanonicalConflict?'authority_changed':'owner_unknown');
    }catch{/* Unknown primary SQL/commit state must remain pending, never imply absence. */}
   }
   throw safe(error);
  }
 }
 async function reconcile(attemptId){
  const repo=repository(null);let current;
  try{
   current=await repo.claimRecovery(attemptId);
   if(terminal(current.row))return R.dto(current.row);
   if(current.row.state==='sql_committed')return R.dto((await acknowledge(repo,current)).row);
   if(current.row.state==='prepared'||current.row.state==='quarantine_pending')return R.dto((await close(repo,current)).row);
   current=await observe(repo,current);
   if(current.row.state==='sql_committed')return R.dto((await acknowledge(repo,current)).row);
   const receipt=current.row.owner_receipt?R.json(current.row.owner_receipt):null;
   // No bearer/session is manufactured for a worker. While the original live
   // user can still retry, park. Otherwise fence SQL and close only this grant.
   if(receipt&&receipt.validUntil>clock()&&R.json(current.row.owner_observation).state==='confirmed_current'&&await mayContinue(current.row)===true){current=await repo.park(current.fence,'recovery_pending',{delayMs:15000});return R.dto(current.row);}
   return R.dto((await close(repo,current)).row);
  }catch(error){
   if(current&&!terminal(current.row))try{await repo.park(current.fence,error?.recoveryCanonicalConflict?'authority_changed':'owner_unknown',{delayMs:15000});}catch{}
   throw safe(error);
  }
 }
 return Object.freeze({publish,reconcile});
}
module.exports={createGoogleOAuthAdmissionRecoveryCoordinator};
