'use strict';
module.exports = (sequelize,D) => sequelize.define('GoogleOAuthAdmissionRecovery', {
  attempt_id:{ type:D.CHAR(36),primaryKey:true,allowNull:false },crm_intent_id:{ type:D.CHAR(36),allowNull:false,unique:true },
  dispatch_request_id:{ type:D.CHAR(36),allowNull:false,unique:true },binding_digest:{ type:D.CHAR(64),allowNull:false },
  actor_user_id:{ type:D.INTEGER,allowNull:false },session_ref_hash:{ type:D.CHAR(64),allowNull:false },session_expires_at:{ type:D.DATE(3),allowNull:false },
  scope_key:{ type:D.STRING(64),allowNull:false },clinic_ids:{ type:D.TEXT,allowNull:false },clinic_digest:{ type:D.CHAR(64),allowNull:false },
  service:{ type:D.ENUM('analytics'),allowNull:false },clinic_id:{ type:D.INTEGER,allowNull:false },asset_ref:{ type:D.STRING(128),allowNull:false },selection_digest:{ type:D.CHAR(64),allowNull:false },
  attempt_requested_at:{ type:D.DATE(3),allowNull:false },attempt_expires_at:{ type:D.DATE(3),allowNull:false },google_user_id:{ type:D.STRING(128),allowNull:true },
  subject_digest:{ type:D.CHAR(64),allowNull:true },claim_digest:{ type:D.CHAR(64),allowNull:true },scope_lock:{ type:D.CHAR(64),allowNull:true,unique:true },subject_lock:{ type:D.CHAR(64),allowNull:true,unique:true },
  state:{ type:D.ENUM('prepared','dispatch_pending','effect_unknown','remote_confirmed','sql_committed','published','quarantine_pending','quarantined','closed_unused'),allowNull:false },
  revision:{ type:D.INTEGER.UNSIGNED,allowNull:false },generation:{ type:D.INTEGER.UNSIGNED,allowNull:false },lease_token:{ type:D.CHAR(36),allowNull:true },lease_until:{ type:D.DATE(3),allowNull:true },
  owner_observation:{ type:D.TEXT,allowNull:true },owner_observation_digest:{ type:D.CHAR(64),allowNull:true },owner_receipt:{ type:D.TEXT,allowNull:true },owner_receipt_digest:{ type:D.CHAR(64),allowNull:true },
  native_resource:{ type:D.TEXT,allowNull:true },native_resource_digest:{ type:D.CHAR(64),allowNull:true },sql_publication_digest:{ type:D.CHAR(64),allowNull:true },last_error:{ type:D.STRING(48),allowNull:true },
  created_at:{ type:D.DATE(3),allowNull:false },updated_at:{ type:D.DATE(3),allowNull:false },completed_at:{ type:D.DATE(3),allowNull:true },
},{ tableName:'GoogleOAuthAdmissionRecoveries',timestamps:false,charset:'utf8mb4',collate:'utf8mb4_bin',indexes:[{ fields:['state','lease_until'] }] });
