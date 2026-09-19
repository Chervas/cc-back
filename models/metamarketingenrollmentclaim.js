'use strict';
module.exports=(sequelize,D)=>sequelize.define('MetaMarketingEnrollmentClaim',{
  asset_ref:{type:D.STRING(128),primaryKey:true,allowNull:false},enrollment_id:{type:D.CHAR(36),allowNull:false},created_at:{type:D.DATE(3),allowNull:false},
},{tableName:'MetaMarketingEnrollmentClaims',timestamps:false,charset:'ascii',collate:'ascii_bin',indexes:[{name:'cc_meta_enroll_claim_owner',fields:['enrollment_id']}]});
