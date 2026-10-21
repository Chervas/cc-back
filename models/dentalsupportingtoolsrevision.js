'use strict';
module.exports=(sequelize,D)=>sequelize.define('DentalSupportingToolsRevision',{
  id:{type:D.BIGINT.UNSIGNED,primaryKey:true,autoIncrement:true},tool_id:{type:D.BIGINT.UNSIGNED,allowNull:false},version_number:{type:D.INTEGER.UNSIGNED,allowNull:false},
  snapshot:{type:D.JSON,allowNull:false},command_key:{type:D.STRING(120),allowNull:false},command_hash:{type:D.STRING(64),allowNull:false},
  command_type:{type:D.STRING(40),allowNull:false},actor_id:{type:D.INTEGER,allowNull:false},
},{tableName:'DentalSupportingToolsRevisions',underscored:true,createdAt:'created_at',updatedAt:false,
  hooks:{beforeUpdate(){throw Error('dental_tools_revision_immutable');},beforeDestroy(){throw Error('dental_tools_revision_immutable');},beforeBulkUpdate(){throw Error('dental_tools_revision_immutable');},beforeBulkDestroy(){throw Error('dental_tools_revision_immutable');}}});
