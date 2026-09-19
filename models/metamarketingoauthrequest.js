'use strict';
module.exports=(sequelize,D)=>sequelize.define('MetaMarketingOAuthRequest',{
  flow_id:{type:D.UUID,primaryKey:true,allowNull:false},state_hash:{type:D.CHAR(64),unique:true,allowNull:false},
  scope_key:{type:D.STRING(64),allowNull:false},connection_ref:{type:D.STRING(128),allowNull:false},asset_ref:{type:D.STRING(128),allowNull:false},
  app_id:{type:D.STRING(30),allowNull:false},clinic_ids:{type:D.TEXT,allowNull:false},scopes:{type:D.TEXT,allowNull:false},redirect_uri:{type:D.STRING(512),allowNull:false},
  slot_digest:{type:D.CHAR(64),allowNull:false},scope_digest:{type:D.CHAR(64),allowNull:false},
  actor_user_id:{type:D.INTEGER,allowNull:false},session_ref:{type:D.UUID,allowNull:false},session_expires_at:{type:D.DATE(3),allowNull:false},
  return_origin:{type:D.STRING(256),allowNull:false},requested_at:{type:D.DATE(3),allowNull:false},expires_at:{type:D.DATE(3),allowNull:false},
  state:{type:D.ENUM('begin_pending','awaiting','processing','staged','cancel_pending','cancelled','interrupted'),allowNull:false},
  code_digest:{type:D.CHAR(64),unique:true,allowNull:true},candidate_metadata:{type:D.TEXT,allowNull:true},
  attempts:{type:D.INTEGER.UNSIGNED,allowNull:false,defaultValue:0},next_attempt_at:{type:D.DATE(3),allowNull:false},
  lease_token:{type:D.UUID,allowNull:true},lease_until:{type:D.DATE(3),allowNull:true},last_error:{type:D.STRING(48),allowNull:true},completed_at:{type:D.DATE(3),allowNull:true},
},{tableName:'MetaMarketingOAuthRequests',timestamps:false,indexes:[
  {name:'cc_meta_oauth_delivery',fields:['state','next_attempt_at','lease_until']},
  {name:'cc_meta_oauth_scope',fields:['scope_key','requested_at']},
  {name:'cc_meta_oauth_scope_state',fields:['scope_key','state']},
]});
