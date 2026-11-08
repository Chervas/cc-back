'use strict';
const C=require('./metaMarketingCredentialRenewal.contract'),B=require('../../services/integrations-broker/src/meta-marketing-business-contract');
const A=require('../../services/integrations-broker/src/meta-marketing-agency-contract');
const ISSUERS=['BISU',A.ISSUER],issuer=value=>value?.issuerKind===A.ISSUER?A.ISSUER:value?.tokenType==='USER'?'USER':'BISU';
const PERMISSION_PROFILES=Object.freeze(['legacy-v1','paid-leads-v2']);
function permissionProfile(value='legacy-v1'){if(!PERMISSION_PROFILES.includes(value))fail();return value;}
function cohortFor(kind,profile='legacy-v1'){if(!ISSUERS.includes(kind))fail();return kind===A.ISSUER?(permissionProfile(profile)==='legacy-v1'?A.COHORT:A.PAID_COHORT):(permissionProfile(profile)==='legacy-v1'?B.COHORT:B.PAID_COHORT);}
const scopesFor=(kind,profile='legacy-v1')=>(kind===A.ISSUER?A:B).scopesForCohort(cohortFor(kind,profile));
function profileForScopes(kind,serialized){for(const profile of PERMISSION_PROFILES)if(serialized===JSON.stringify(scopesFor(kind,profile)))return profile;fail();}
const policyDigestParts=policy=>permissionProfile(policy.permissionProfile)==='legacy-v1'?[]:['paid-leads-v2',scopesFor(policy.issuerKind,'paid-leads-v2')];
const providerBusinessId=value=>issuer(value)===A.ISSUER?value.issuerBusinessId:null;
const pin=row=>{const profile=row.scopes===undefined?'legacy-v1':profileForScopes(row.issuer_kind,row.scopes);return {appId:row.app_id,configId:row.config_id,graphVersion:row.graph_version,issuerKind:row.issuer_kind,issuerBusinessId:row.issuer_business_id,
  ...(profile==='legacy-v1'?{}:{cohort:cohortFor(row.issuer_kind,profile)})};};
const IMMUTABLE=['enrollment_id','flow_id','scope_key','connection_ref','scope_digest','flow_digest','candidate_digest','meta_user_id','app_id','assignment_digest','clinic_ids','assets','mapping_ids','meta_connection_id','actor_user_id','session_ref','session_expires_at','requested_at','prepared_at','activated_at','selection_digest'];
const freeze=row=>Object.fromEntries(IMMUTABLE.map(key=>[key,row[key] instanceof Date?row[key].toISOString():row[key]]));
const ERRORS=new Set(['meta_business_disabled','meta_business_unavailable','meta_business_invalid','meta_business_scope_forbidden','meta_business_scope_changed','meta_business_identity_mismatch','meta_business_candidate_rejected','meta_business_expired','meta_business_busy','meta_business_drain_pending','meta_business_activation_uncertain','meta_business_version_changed','meta_business_session_required','auth_email_verification_required','broker_response_invalid','broker_configuration_invalid','broker_timeout','broker_unavailable','rate_limited','provider_timeout','audit_unavailable','outcome_unknown']);
const fail=(code='meta_business_unavailable',status=503)=>C.fail(code,status);
const safe=error=>ERRORS.has(error?.code)?error.code:error?.code==='oauth_identity_mismatch'?'meta_business_identity_mismatch':
  ['scope_denied','asset_revoked','connection_blocked','meta_enrollment_scope_changed'].includes(error?.code)?'meta_business_scope_changed':
  ['secret_version_changed','meta_renewal_version_changed'].includes(error?.code)?'meta_business_version_changed':
  ['auth_invalid','meta_oauth_session_required'].includes(error?.code)?'meta_business_session_required':
  ['meta_oauth_scope_forbidden','meta_renewal_scope_forbidden'].includes(error?.code)?'meta_business_scope_forbidden':
  ['oauth_credentials_incomplete','credential_revoked','permissions_lost'].includes(error?.code)?'meta_business_candidate_rejected':'meta_business_unavailable';
function metadata(value,pin){
  if(!ISSUERS.includes(pin.issuerKind)||issuer(value)!==pin.issuerKind)fail('meta_business_identity_mismatch',409);
  if(pin.issuerKind===A.ISSUER&&(value.issuerBusinessId!==pin.issuerBusinessId||value.subjectId!==value.systemUserId))fail('meta_business_identity_mismatch',409);
  try{return pin.issuerKind===A.ISSUER?A.validateAgencyMetadata(value,pin):B.validateMetadata(value,pin);}catch{fail('broker_response_invalid');}
}
function candidate(value,pin){
  if(!value||!C.UUID.test(value.versionId)||!C.HASH.test(value.digest))fail('broker_response_invalid');
  const {versionId,digest,...rest}=value;return {versionId,digest,...metadata(rest,pin)};
}
function request(row){
  if(!row||!C.STATES.includes(row.state)||!C.UUID.test(row.handover_id)||row.new_enrollment_id!==row.handover_id||!C.UUID.test(row.old_enrollment_id)
    ||!C.UUID.test(row.session_ref)||!C.positive(Number(row.actor_user_id))||!Number.isSafeInteger(Number(row.expected_epoch))||Number(row.expected_epoch)<0
    ||!C.UUID.test(row.expected_version_id)||!C.HASH.test(row.expected_candidate_digest)||!C.HASH.test(row.state_hash)
    ||!['source_digest','scope_digest','old_scope_digest','asset_set_digest'].every(key=>C.HASH.test(row[key]))
    ||(C.TERMINAL.includes(row.state)?null:row.scope_key)!==row.pending_scope_key)fail();
  for(const key of ['begin_request_id','finish_request_id','activate_request_id','abort_request_id','drain_request_id','revoke_request_id'])if(!C.UUID.test(row[key]))fail();
  for(const key of ['requested_at','updated_at','expires_at','next_attempt_at','session_expires_at'])if(!(row[key] instanceof Date)||!Number.isFinite(+row[key]))fail();
  if(!/^(clinic|group):[1-9][0-9]{0,9}$/.test(row.scope_key)||!/^([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.test(row.connection_ref)
    ||![row.app_id,row.config_id].every(id=>typeof id==='string'&&/^[1-9][0-9]{0,29}$/.test(id))||!/^v(?:24|25|26|27)\.0$/.test(row.graph_version)
    ||!ISSUERS.includes(row.issuer_kind)||(row.issuer_kind===A.ISSUER?!/^[1-9][0-9]{0,29}$/.test(row.issuer_business_id||''):row.issuer_business_id!==null)
    ||typeof row.scopes!=='string')fail();
  profileForScopes(row.issuer_kind,row.scopes);
  const clinicIds=C.clinics(row.clinic_ids);let selected,source,candidateValue;
  try{selected=C.assets(JSON.parse(row.assets));source=JSON.parse(row.source_snapshot);candidateValue=row.candidate_metadata?candidate(JSON.parse(row.candidate_metadata),pin(row)):null;}catch{fail();}
  if(!C.exact(source,IMMUTABLE.join(','))||source.enrollment_id!==row.old_enrollment_id||source.scope_key!==row.scope_key||source.app_id!==row.app_id||source.scope_digest!==row.old_scope_digest
    ||source.clinic_ids!==row.clinic_ids||source.assets!==row.assets||source.mapping_ids!==row.mapping_ids||source.connection_ref!==row.connection_ref
    ||JSON.stringify(selected)!==row.assets||C.F.assetSetDigest(selected)!==row.asset_set_digest||C.hash(JSON.stringify(source))!==row.source_digest
    ||candidateValue&&candidateValue.versionId!==row.handover_id||['staged','activate_pending','active'].includes(row.state)&&!candidateValue)fail();
  return {...row,clinicIds,selected,source,candidate:candidateValue};
}
const sourceFlow=row=>({flow_id:row.handover_id,app_id:row.app_id,scopes:row.scopes,candidate_metadata:row.candidate_metadata,businessSource:true});
const sourceDigest=row=>C.hash(JSON.stringify([row.handover_id,row.old_enrollment_id,row.source_digest,row.scope_digest,row.clinic_ids,row.assets,row.app_id,row.issuer_kind,row.issuer_business_id,row.config_id,row.graph_version,row.scopes,row.candidate_metadata]));
function receipt(value,row){
  if(!C.exact(value,'handoverId,flowId,newEnrollmentId,oldEnrollmentId,status,oldGrantDigest,assetSetDigest,candidate,newEnrollment,handoverApplied,drain')
    ||value.handoverId!==row.handover_id||value.flowId!==row.handover_id
    ||!B.STATES.includes(value.status)||typeof value.handoverApplied!=='boolean')fail('broker_response_invalid');
  if(value.status==='not_found'){if(value.newEnrollmentId!==null||value.oldEnrollmentId!==null||value.oldGrantDigest!==null||value.assetSetDigest!==null||value.candidate!==null||value.newEnrollment!==null||value.handoverApplied||value.drain!==null)fail('broker_response_invalid');return structuredClone(value);}
  if(value.newEnrollmentId!==row.handover_id||value.oldEnrollmentId!==row.old_enrollment_id)fail('broker_response_invalid');
  if(!C.HASH.test(value.oldGrantDigest)||row.old_grant_digest!==null&&row.old_grant_digest!==value.oldGrantDigest||value.assetSetDigest!==row.asset_set_digest)fail('broker_response_invalid');
  if(value.candidate!==null){if(!C.exact(value.candidate,'versionId,digest,metadata')||value.candidate.versionId!==row.handover_id||!['staged','active'].includes(value.status))fail('broker_response_invalid');candidate({versionId:value.candidate.versionId,digest:value.candidate.digest,...value.candidate.metadata},pin(row));}
  else if(['staged','active'].includes(value.status))fail('broker_response_invalid');
  if(value.handoverApplied!== (value.status==='active')||!value.handoverApplied&&value.newEnrollment!==null||value.handoverApplied&&!value.newEnrollment)fail('broker_response_invalid');
  if(value.drain!==null&&(!C.exact(value.drain,'receiptRefs,receiptSetDigest,activeOperations,closed')||value.drain.closed!==true||!Number.isSafeInteger(value.drain.activeOperations)||value.drain.activeOperations<0
    ||!Array.isArray(value.drain.receiptRefs)||value.drain.receiptRefs.length>1000||value.drain.receiptRefs.some((id,i,all)=>!C.UUID.test(id)||i>0&&id<=all[i-1])
    ||value.drain.receiptSetDigest!==B.drainDigest(row.handover_id,value.oldGrantDigest,value.drain.receiptRefs)))fail('broker_response_invalid');
  return structuredClone(value);
}
module.exports={...C,B,A,ISSUERS,issuer,PERMISSION_PROFILES,permissionProfile,cohortFor,scopesFor,profileForScopes,policyDigestParts,providerBusinessId,pin,IMMUTABLE,freeze,ERRORS,fail,safe,metadata,candidate,request,receipt,sourceFlow,sourceDigest};
