'use strict';
module.exports = {
 async up(queryInterface, S) {
  await queryInterface.createTable('GoogleAdsGoalPolicyJournals', {
   id: {type:S.CHAR(36),primaryKey:true,allowNull:false},
   policy_id: {type:S.BIGINT.UNSIGNED,allowNull:false}, intake_config_id:{type:S.INTEGER,allowNull:false},
   customer_id:{type:S.CHAR(10),allowNull:false}, scope_key:{type:S.CHAR(64),allowNull:false},
   active_lock_key:{type:S.CHAR(64),allowNull:true}, plan_digest:{type:S.CHAR(64),allowNull:false},
   scope_digest:{type:S.CHAR(64),allowNull:false}, mandate_digest:{type:S.CHAR(64),allowNull:false},
   policy_version:{type:S.INTEGER.UNSIGNED,allowNull:false}, lease_token:{type:S.CHAR(36),allowNull:false},
   state:{type:S.STRING(16),allowNull:false}, journal:{type:S.JSON,allowNull:false},
   version:{type:S.INTEGER.UNSIGNED,allowNull:false},
   created_at:{type:S.DATE(3),allowNull:false}, updated_at:{type:S.DATE(3),allowNull:false},
  }, {engine:'InnoDB',charset:'utf8mb4',collate:'utf8mb4_0900_ai_ci'});
  await queryInterface.addIndex('GoogleAdsGoalPolicyJournals',['active_lock_key'],{name:'uq_goal_policy_active_lock',unique:true});
  await queryInterface.addIndex('GoogleAdsGoalPolicyJournals',['customer_id','created_at'],{name:'ix_goal_policy_customer_history'});
  await queryInterface.addIndex('GoogleAdsGoalPolicyJournals',['policy_id','created_at'],{name:'ix_goal_policy_policy_history'});
 },
 async down(){throw Error('GOAL_POLICY_JOURNAL_RETENTION_REQUIRED');},
};
