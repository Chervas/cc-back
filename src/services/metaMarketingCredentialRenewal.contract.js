'use strict';
const C=require('./metaMarketingEnrollment.contract'),F=require('./metaMarketingEffectiveCredential.service');
const U=require('../../services/integrations-broker/src/meta-marketing-credential-renewal-contract');
const STATES=['begin_pending','awaiting','processing','staged','activate_pending','active','cancel_pending','cancelled','rejected','interrupted'];
const TERMINAL=['active','cancelled','rejected','interrupted'];
const ERRORS=new Set(['meta_renewal_invalid','meta_renewal_scope_forbidden','meta_renewal_scope_changed','meta_renewal_busy','meta_renewal_session_required','meta_renewal_disabled','meta_renewal_unavailable',
  'meta_renewal_candidate_rejected','meta_renewal_identity_mismatch','meta_renewal_assets_insufficient','meta_renewal_version_changed','meta_renewal_expired','auth_email_verification_required',
  'broker_response_invalid','broker_configuration_invalid','broker_timeout','broker_unavailable','rate_limited','provider_timeout','outcome_unknown','audit_unavailable']);
const fail=(code='meta_renewal_unavailable',status=503)=>C.fail(code,status);
const safe=error=>ERRORS.has(error?.code)?error.code:['scope_denied','asset_revoked','connection_blocked','meta_credential_version_invalid'].includes(error?.code)?'meta_renewal_scope_changed':
  error?.code==='oauth_identity_mismatch'?'meta_renewal_identity_mismatch':
  ['secret_version_changed','idempotency_conflict'].includes(error?.code)?'meta_renewal_version_changed':
  ['credential_revoked','provider_unauthorized','permissions_lost','oauth_credentials_incomplete','provider_failed'].includes(error?.code)?'meta_renewal_candidate_rejected':
  ['auth_invalid','meta_oauth_session_required'].includes(error?.code)?'meta_renewal_session_required':'meta_renewal_unavailable';
function request(row){
  if(!row||!STATES.includes(row.state))fail();
  for(const key of ['renewal_id','enrollment_id','expected_version_id','session_ref','begin_request_id','finish_request_id','activate_request_id','abort_request_id'])if(!C.UUID.test(row[key]))fail();
  for(const key of ['state_hash','scope_digest','slot_digest','asset_set_digest','expected_candidate_digest'])if(!C.HASH.test(row[key]))fail();
  if(!/^(clinic|group):[1-9][0-9]{0,9}$/.test(row.scope_key)||!C.positive(Number(row.actor_user_id))||!C.positive(Number(row.meta_connection_id))
    ||!Number.isSafeInteger(Number(row.expected_epoch))||Number(row.expected_epoch)<0||![row.app_id,row.meta_user_id].every(value=>typeof value==='string'&&/^[1-9][0-9]{0,29}$/.test(value)))fail();
  const clinicIds=C.clinics(row.clinic_ids);let selected,scopes,candidate;
  try{selected=C.assets(JSON.parse(row.assets));scopes=JSON.parse(row.scopes);candidate=row.candidate_metadata?JSON.parse(row.candidate_metadata):null;}catch{fail();}
  if(JSON.stringify(selected)!==row.assets||F.assetSetDigest(selected)!==row.asset_set_digest||!Array.isArray(scopes)||JSON.stringify([...new Set(scopes)].sort())!==row.scopes)fail();
  if(candidate)candidate=F.candidate(candidate,row,scopes);
  if(candidate&&candidate.versionId!==row.renewal_id||['staged','activate_pending','active'].includes(row.state)&&!candidate)fail();
  if((TERMINAL.includes(row.state)?null:row.enrollment_id)!==row.pending_enrollment_id)fail();
  for(const key of ['requested_at','expires_at','updated_at','next_attempt_at','session_expires_at'])if(!(row[key] instanceof Date)||!Number.isFinite(+row[key]))fail();
  return {...row,clinicIds,selected,candidate,scopeValues:scopes};
}
function receipt(value,row,{allowAbortedVersionDrift=false}={}){
  if(!C.exact(value,'renewalId,flowId,enrollmentId,status,grantDigest,assetSetDigest,effectiveCredential,candidate,activationApplied')
    ||value.renewalId!==row.renewal_id||value.flowId!==row.renewal_id||!U.STATES.includes(value.status)||typeof value.activationApplied!=='boolean')fail('broker_response_invalid');
  if(value.status==='not_found'){
    if(['enrollmentId','grantDigest','assetSetDigest','effectiveCredential','candidate'].some(key=>value[key]!==null)||value.activationApplied)fail('broker_response_invalid');
    return structuredClone(value);
  }
  if(value.enrollmentId!==row.enrollment_id||value.assetSetDigest!==row.asset_set_digest||!C.HASH.test(value.grantDigest)||row.grant_digest!==null&&row.grant_digest!==value.grantDigest)fail('broker_response_invalid');
  const effective=value.effectiveCredential;
  if(!C.exact(effective,'epoch,versionId,digest,metadata')||!Number.isSafeInteger(effective.epoch)||effective.epoch<0||!C.UUID.test(effective.versionId)||!C.HASH.test(effective.digest))fail('broker_response_invalid');
  F.candidate({versionId:effective.versionId,digest:effective.digest,...effective.metadata},row,row.scopeValues);
  if(value.candidate!==null){
    if(!C.exact(value.candidate,'versionId,digest,metadata')||!['staged','active'].includes(value.status)||value.candidate.versionId!==row.renewal_id)fail('broker_response_invalid');
    F.candidate({versionId:value.candidate.versionId,digest:value.candidate.digest,...value.candidate.metadata},row,row.scopeValues);
  }else if(['staged','active'].includes(value.status))fail('broker_response_invalid');
  if(value.activationApplied){
    if(value.status!=='active'||effective.epoch!==Number(row.expected_epoch)+1||effective.versionId!==row.renewal_id||effective.digest!==value.candidate.digest
      ||JSON.stringify(effective.metadata)!==JSON.stringify(value.candidate.metadata))fail('broker_response_invalid');
  }else if(value.status==='active'||(!allowAbortedVersionDrift||!['aborted','rejected','interrupted'].includes(value.status))
    &&(effective.epoch!==Number(row.expected_epoch)||effective.versionId!==row.expected_version_id||effective.digest!==row.expected_candidate_digest))fail('meta_renewal_version_changed',409);
  return structuredClone(value);
}
module.exports={...C,U,F,STATES,TERMINAL,ERRORS,fail,safe,request,receipt};
