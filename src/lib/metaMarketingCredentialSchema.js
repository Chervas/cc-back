'use strict';
// Pure DDL/model definitions: no application models, environment or credentials.
function renewalFields(D){
  const out={};
  for(const key of ['renewal_id','enrollment_id','expected_version_id','session_ref','begin_request_id','finish_request_id','activate_request_id','abort_request_id'])
    out[key]={type:D.CHAR(36),allowNull:false,...(key==='renewal_id'?{primaryKey:true}:{})};
  out.pending_enrollment_id={type:D.CHAR(36),allowNull:true};
  for(const [key,size] of [['scope_key',64],['connection_ref',128],['app_id',30],['meta_user_id',30],['scope_digest',64],['slot_digest',64],['asset_set_digest',64],['state_hash',64],['expected_candidate_digest',64],['redirect_uri',512],['return_origin',256]])out[key]={type:D.STRING(size),allowNull:false};
  for(const key of ['clinic_ids','assets','scopes'])out[key]={type:D.TEXT,allowNull:false};
  for(const key of ['meta_connection_id','actor_user_id'])out[key]={type:D.INTEGER,allowNull:false};
  out.expected_epoch={type:D.INTEGER.UNSIGNED,allowNull:false};
  for(const key of ['requested_at','expires_at','updated_at','next_attempt_at','session_expires_at'])out[key]={type:D.DATE(3),allowNull:false};
  for(const key of ['completed_at','lease_until','activate_sent_at'])out[key]={type:D.DATE(3),allowNull:true};
  for(const key of ['candidate_metadata','owner_receipt'])out[key]={type:D.TEXT('long'),allowNull:true};
  for(const key of ['grant_digest','code_digest'])out[key]={type:D.CHAR(64),allowNull:true};
  out.last_error={type:D.STRING(64),allowNull:true};out.lease_token={type:D.CHAR(36),allowNull:true};
  out.attempts={type:D.INTEGER.UNSIGNED,allowNull:false,defaultValue:0};
  out.state={type:D.ENUM('begin_pending','awaiting','processing','staged','activate_pending','active','cancel_pending','cancelled','rejected','interrupted'),allowNull:false};
  return out;
}
function effectiveFields(D){return {
  enrollment_id:{type:D.CHAR(36),allowNull:false,primaryKey:true},renewal_id:{type:D.CHAR(36),allowNull:true},
  epoch:{type:D.INTEGER.UNSIGNED,allowNull:false},version_id:{type:D.CHAR(36),allowNull:false},candidate_digest:{type:D.CHAR(64),allowNull:false},
  candidate_metadata:{type:D.TEXT('long'),allowNull:false},owner_receipt_digest:{type:D.CHAR(64),allowNull:true},activated_at:{type:D.DATE(3),allowNull:false},
  last_error:{type:D.STRING(64),allowNull:true},last_error_at:{type:D.DATE(3),allowNull:true},
  unknown_since:{type:D.DATE(3),allowNull:true},last_healthy_at:{type:D.DATE(3),allowNull:true}
};}
const MIGRATION='20261107203000-create-meta-marketing-credential-renewals.js';
const TABLES=['MetaMarketingCredentialRenewals','MetaMarketingEffectiveCredentials'];
module.exports={renewalFields,effectiveFields,MIGRATION,TABLES};
