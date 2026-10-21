'use strict';
module.exports=(sequelize,D)=>sequelize.define('DentalPlanRevision',{
 id:{type:D.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true},plan_id:{type:D.BIGINT.UNSIGNED,allowNull:false},version_number:{type:D.INTEGER.UNSIGNED,allowNull:false},
 snapshot:{type:D.JSON,allowNull:false},sha256:{type:D.STRING(64),allowNull:false},command:{type:D.STRING(40),allowNull:false},
 mutation_key:{type:D.STRING(64),allowNull:false},request_hash:{type:D.STRING(64),allowNull:false},actor_id:{type:D.INTEGER,allowNull:false},created_at:{type:D.DATE,allowNull:false},
},{tableName:'DentalPlanRevisions',underscored:true,timestamps:false,hooks:{
 beforeUpdate(){throw Error('dental_plan_revision_immutable');},beforeDestroy(){throw Error('dental_plan_revision_immutable');},
 beforeBulkUpdate(){throw Error('dental_plan_revision_immutable');},beforeBulkDestroy(){throw Error('dental_plan_revision_immutable');},
}});
