'use strict';
module.exports=(sequelize,D)=>sequelize.define('GoogleAdsGoalPolicyJournal',{
 id:{type:D.CHAR(36),primaryKey:true,allowNull:false},policy_id:{type:D.BIGINT.UNSIGNED,allowNull:false},
 intake_config_id:{type:D.INTEGER,allowNull:false},customer_id:{type:D.CHAR(10),allowNull:false},
 scope_key:{type:D.CHAR(64),allowNull:false},active_lock_key:{type:D.CHAR(64),allowNull:true},
 plan_digest:{type:D.CHAR(64),allowNull:false},scope_digest:{type:D.CHAR(64),allowNull:false},
 mandate_digest:{type:D.CHAR(64),allowNull:false},policy_version:{type:D.INTEGER.UNSIGNED,allowNull:false},
 lease_token:{type:D.CHAR(36),allowNull:false},state:{type:D.STRING(16),allowNull:false},
 journal:{type:D.JSON,allowNull:false},version:{type:D.INTEGER.UNSIGNED,allowNull:false},
 created_at:{type:D.DATE(3),allowNull:false},updated_at:{type:D.DATE(3),allowNull:false},
},{tableName:'GoogleAdsGoalPolicyJournals',timestamps:false,indexes:[
 {name:'uq_goal_policy_active_lock',unique:true,fields:['active_lock_key']},
 {name:'ix_goal_policy_customer_history',fields:['customer_id','created_at']},
 {name:'ix_goal_policy_policy_history',fields:['policy_id','created_at']},
]});
