'use strict';
module.exports=(sequelize,D)=>sequelize.define('MetaMarketingEnrollmentIdentity',{
  meta_user_id:{type:D.STRING(30),primaryKey:true,allowNull:false},app_id:{type:D.STRING(30),allowNull:false},meta_connection_id:{type:D.INTEGER,allowNull:false,unique:true},created_at:{type:D.DATE(3),allowNull:false},
},{tableName:'MetaMarketingEnrollmentIdentities',timestamps:false,charset:'ascii',collate:'ascii_bin'});
