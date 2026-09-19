'use strict';
const C=require('./metaMarketingOAuth.contract'),E=require('../../services/integrations-broker/src/meta-marketing-enrollment-contract');
const HASH=/^[a-f0-9]{64}$/,STATES=['prepare_pending','prepared','activate_pending','active','revoke_pending','revoked'];
const fail=(code='meta_enrollment_unavailable',httpStatus=503)=>C.fail(code,httpStatus);
function assets(value){try{return E.assets(value);}catch{fail('meta_enrollment_invalid',400);}}
const physical=value=>[...new Set(assets(value).flatMap(a=>[a.assetRef,...(a.parentPageId?['meta-facebook_page:'+a.parentPageId]:[])]))].sort();
function clinics(value){let ids;try{ids=JSON.parse(value);}catch{fail();}
  if(!Array.isArray(ids)||!ids.length||ids.length>1000||ids.some((v,i)=>!C.positive(v)||i>0&&v<=ids[i-1])||JSON.stringify(ids)!==value)fail();return ids;}
function sourceDigest(row){return C.hash(JSON.stringify(['flow_id','scope_key','connection_ref','asset_ref','app_id','clinic_ids','scopes','redirect_uri','slot_digest','scope_digest',
  'actor_user_id','session_ref','session_expires_at','state_hash','candidate_metadata'].map(k=>row[k] instanceof Date?row[k].toISOString():row[k])));}
function request(row){
  if(!row||!STATES.includes(row.state))fail();
  for(const key of ['enrollment_id','flow_id','session_ref','prepare_request_id','activate_request_id','revoke_request_id'])if(!C.UUID.test(row[key]))fail();
  if(new Set(['enrollment_id','prepare_request_id','activate_request_id','revoke_request_id'].map(k=>row[k])).size!==4)fail();
  for(const key of ['scope_digest','flow_digest','candidate_digest','assignment_digest'])if(!HASH.test(row[key]))fail();
  if(!/^(clinic|group):[1-9][0-9]{0,9}$/.test(row.scope_key)||!C.positive(Number(row.scope_key.split(':')[1]))||!C.positive(Number(row.actor_user_id))||!C.positive(Number(row.meta_connection_id))
    ||!/^([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.test(row.connection_ref)||![row.meta_user_id,row.app_id].every(v=>typeof v==='string'&&/^[1-9][0-9]{0,29}$/.test(v)))fail();
  const ids=clinics(row.clinic_ids);let selected,mappings;try{selected=assets(JSON.parse(row.assets));mappings=JSON.parse(row.mapping_ids);}catch{fail();}
  if(JSON.stringify(selected)!==row.assets||row.scope_key.startsWith('clinic:')&&(ids.length!==1||row.scope_key!=='clinic:'+ids[0])
    ||!Array.isArray(mappings)||JSON.stringify(mappings)!==row.mapping_ids||mappings.some((v,i)=>!C.positive(v)||i>0&&v<=mappings[i-1])||mappings.length>1000)fail();
  for(const key of ['session_expires_at','requested_at','updated_at','next_attempt_at'])if(!(row[key] instanceof Date)||!Number.isFinite(+row[key]))fail();
  for(const key of ['prepared_at','activated_at','revoked_at'])if(row[key]!==null&&(!(row[key] instanceof Date)||!Number.isFinite(+row[key])))fail();
  for(const key of ['prepare_sent_at','activate_sent_at'])if(Object.hasOwn(row,key)&&row[key]!==null&&(!(row[key] instanceof Date)||!Number.isFinite(+row[key])))fail();
  if(!Number.isInteger(Number(row.attempts))||Number(row.attempts)<0||Number(row.attempts)>1000000000
    ||row.selection_digest!==null&&!HASH.test(row.selection_digest)||['prepared','activate_pending','active'].includes(row.state)&&!HASH.test(row.selection_digest)
    ||['prepared','activate_pending','active'].includes(row.state)&&row.prepared_at===null
    ||row.state==='active'&&(row.activated_at===null||!mappings.length)
    ||row.state==='revoked'&&row.revoked_at===null
    ||row.state==='prepare_pending'&&(row.selection_digest!==null||row.prepared_at!==null||row.activated_at!==null||mappings.length)
    ||row.last_error!==null&&(typeof row.last_error!=='string'||!(/^[a-z_]{1,64}$/).test(row.last_error))
    ||(row.lease_token===null)!==(row.lease_until===null)||row.lease_token!==null&&(!C.UUID.test(row.lease_token)||!(row.lease_until instanceof Date)||!Number.isFinite(+row.lease_until)))fail();
  return {...row,clinicIds:ids,selected,mappingIds:mappings};
}
function receipt(value,row,{states,allowUnknown=false}={}){
  const r=request(row);
  if(allowUnknown&&C.exact(value,'enrollmentId,status,accessBlocked')&&value.enrollmentId===r.enrollment_id&&value.status==='not_found'&&value.accessBlocked===true)return value;
  if(!C.exact(value,'enrollmentId,flowId,scopeKey,scopeDigest,candidateDigest,selectionDigest,clinicSetDigest,assets,status,accessBlocked,preparedAt,activatedAt')
    ||value.enrollmentId!==r.enrollment_id||!Array.isArray(states)||!states.includes(value.status)||value.scopeKey!==r.scope_key||typeof value.accessBlocked!=='boolean'||!Array.isArray(value.assets))fail('broker_response_invalid');
  // A control tombstone can be written before prepare and has no flow/selection.
  if(value.status==='revoked'&&value.flowId===null){
    if(value.scopeDigest!==null||value.candidateDigest!==null||value.selectionDigest!==null||value.assets.length||value.preparedAt!==null||value.activatedAt!==null||value.accessBlocked!==true
      ||value.clinicSetDigest!==C.hash(r.clinic_ids))fail('broker_response_invalid');return value;
  }
  let selected;try{selected=assets(value.assets);}catch{fail('broker_response_invalid');}
  if(value.flowId!==r.flow_id||value.scopeDigest!==r.scope_digest||value.candidateDigest!==r.candidate_digest||value.clinicSetDigest!==C.hash(r.clinic_ids)
    ||JSON.stringify(selected)!==r.assets||!HASH.test(value.selectionDigest)||r.selection_digest!==null&&r.selection_digest!==value.selectionDigest
    ||!Number.isSafeInteger(value.preparedAt)||value.preparedAt<=0||value.activatedAt!==null&&(!Number.isSafeInteger(value.activatedAt)||value.activatedAt<value.preparedAt)
    ||value.status==='active'&&value.activatedAt===null||value.status==='prepared'&&value.activatedAt!==null||value.status!=='active'&&value.accessBlocked!==true)fail('broker_response_invalid');
  return structuredClone(value);
}
module.exports={...C,E,HASH,STATES,fail,assets,physical,clinics,sourceDigest,request,receipt};
