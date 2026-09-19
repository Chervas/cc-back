'use strict';
module.exports=(sequelize,D)=>{
  // delivery_due_at is a database-generated queue index column (migration 11).
  // It is deliberately absent from writable ORM attributes.
  const fields={};
  for(const key of ['enrollment_id','flow_id','session_ref','prepare_request_id','activate_request_id','revoke_request_id'])
    fields[key]={type:D.CHAR(36),allowNull:false,...(key==='enrollment_id'?{primaryKey:true}:['flow_id','prepare_request_id','activate_request_id','revoke_request_id'].includes(key)?{unique:true}:{})};
  for(const [key,size] of [['scope_key',64],['connection_ref',128],['scope_digest',64],['flow_digest',64],['candidate_digest',64],['meta_user_id',30],['app_id',30],['assignment_digest',64]])fields[key]={type:D.STRING(size),allowNull:false};
  for(const key of ['clinic_ids','assets','mapping_ids'])fields[key]={type:D.TEXT,allowNull:false};
  for(const key of ['meta_connection_id','actor_user_id'])fields[key]={type:D.INTEGER,allowNull:false};
  for(const key of ['session_expires_at','requested_at','updated_at','next_attempt_at'])fields[key]={type:D.DATE(3),allowNull:false};
  for(const key of ['prepared_at','activated_at','revoked_at','lease_until','prepare_sent_at','activate_sent_at'])fields[key]={type:D.DATE(3),allowNull:true};
  fields.selection_digest={type:D.CHAR(64),allowNull:true};fields.lease_token={type:D.CHAR(36),allowNull:true};fields.last_error={type:D.STRING(64),allowNull:true};
  fields.attempts={type:D.INTEGER.UNSIGNED,allowNull:false,defaultValue:0};
  fields.state={type:D.ENUM('prepare_pending','prepared','activate_pending','active','revoke_pending','revoked'),allowNull:false};
  return sequelize.define('MetaMarketingEnrollmentRequest',fields,{tableName:'MetaMarketingEnrollmentRequests',timestamps:false,charset:'ascii',collate:'ascii_bin',indexes:[
    {name:'cc_meta_enroll_delivery',fields:['state','next_attempt_at','lease_until']},{name:'cc_meta_enroll_scope',fields:['scope_key','state']},
    {name:'cc_meta_enroll_latest',fields:['scope_key','requested_at','enrollment_id']},{name:'cc_meta_enroll_subject',fields:['meta_user_id']}]});
};
