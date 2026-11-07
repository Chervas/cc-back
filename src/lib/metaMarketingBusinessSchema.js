'use strict';
const date=(D,allowNull=false)=>({type:D.DATE(3),allowNull}),uuid=(D,allowNull=false)=>({type:D.CHAR(36),allowNull});
function handoverFields(D){
  const out={handover_id:{...uuid(D),primaryKey:true},new_enrollment_id:uuid(D),old_enrollment_id:uuid(D),pending_scope_key:{type:D.STRING(64),allowNull:true}};
  out.issuer_kind={type:D.ENUM('BISU','AGENCY_SYSTEM_USER'),allowNull:false};
  out.issuer_business_id={type:D.STRING(30),allowNull:true};
  for(const key of ['session_ref','begin_request_id','finish_request_id','activate_request_id','abort_request_id','revoke_request_id','drain_request_id'])out[key]=uuid(D);
  for(const [key,size]of [['scope_key',64],['connection_ref',128],['app_id',30],['config_id',30],['graph_version',8],['old_scope_digest',64],['source_digest',64],['scope_digest',64],['asset_set_digest',64],['state_hash',64],['expected_version_id',36],['expected_candidate_digest',64],['redirect_uri',512],['return_origin',256]])out[key]={type:D.STRING(size),allowNull:false};
  for(const key of ['clinic_ids','assets','mapping_ids','scopes'])out[key]={type:D.TEXT,allowNull:false};
  for(const key of ['source_snapshot','candidate_metadata','owner_receipt'])out[key]={type:D.TEXT('long'),allowNull:key!=='source_snapshot'};
  for(const key of ['old_grant_digest','code_digest','drain_digest'])out[key]={type:D.CHAR(64),allowNull:true};
  out.new_canonical_id={type:D.INTEGER,allowNull:true};out.actor_user_id={type:D.INTEGER,allowNull:false};out.expected_epoch={type:D.INTEGER.UNSIGNED,allowNull:false};
  for(const key of ['requested_at','updated_at','expires_at','next_attempt_at','session_expires_at'])out[key]=date(D);
  for(const key of ['completed_at','activate_sent_at','retired_at','lease_until'])out[key]=date(D,true);
  out.lease_token=uuid(D,true);out.last_error={type:D.STRING(64),allowNull:true};out.attempts={type:D.INTEGER.UNSIGNED,allowNull:false,defaultValue:0};
  out.state={type:D.ENUM('begin_pending','awaiting','processing','staged','activate_pending','active','cancel_pending','cancelled','rejected','interrupted'),allowNull:false};return out;
}
function maintenanceFields(D){
  const out={maintenance_id:{...uuid(D),primaryKey:true},enrollment_id:uuid(D),pending_enrollment_id:uuid(D,true),rotate_request_id:uuid(D),expected_version_id:uuid(D),expected_epoch:{type:D.INTEGER.UNSIGNED,allowNull:false},expected_candidate_digest:{type:D.CHAR(64),allowNull:false}};
  for(const key of ['candidate_metadata','owner_receipt','health_metadata'])out[key]={type:D.TEXT('long'),allowNull:true};
  out.state={type:D.ENUM('scheduled','running','retry_wait','succeeded','failed','human_required'),allowNull:false};
  for(const key of ['requested_at','updated_at','next_attempt_at','window_started_at'])out[key]=date(D);
  for(const key of ['last_attempt_at','last_healthy_at','unknown_since','completed_at','lease_until','rotate_sent_at','last_health_at','health_next_at'])out[key]=date(D,true);
  out.last_health_error={type:D.STRING(64),allowNull:true};
  out.last_error={type:D.STRING(64),allowNull:true};out.lease_token=uuid(D,true);out.attempts={type:D.INTEGER.UNSIGNED,allowNull:false,defaultValue:0};return out;
}
function drainFields(D){return {handover_id:{...uuid(D),primaryKey:true},enrollment_id:uuid(D),active_enrollment_id:uuid(D,true),scope_key:{type:D.STRING(32),allowNull:false},mapping_ids:{type:D.TEXT('long'),allowNull:false},
  receipt_refs:{type:D.TEXT('long'),allowNull:false},old_grant_digest:{type:D.CHAR(64),allowNull:false},
  asset_set_digest:{type:D.CHAR(64),allowNull:false},drain_digest:{type:D.CHAR(64),allowNull:false},state:{type:D.ENUM('draining','ready','released'),allowNull:false},created_at:date(D),updated_at:date(D),released_at:date(D,true)};}
const MIGRATION='20261107223000-create-meta-marketing-business-continuity.js',TABLES=['MetaMarketingBusinessHandovers','MetaMarketingCredentialMaintenances','MetaMarketingBusinessDrains'];
module.exports={handoverFields,maintenanceFields,drainFields,MIGRATION,TABLES};
