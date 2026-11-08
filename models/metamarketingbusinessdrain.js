'use strict';
const {drainFields}=require('../src/lib/metaMarketingBusinessSchema');
module.exports=(sequelize,D)=>sequelize.define('MetaMarketingBusinessDrain',drainFields(D),{tableName:'MetaMarketingBusinessDrains',timestamps:false,charset:'ascii',collate:'ascii_bin',indexes:[
  {name:'cc_meta_business_drain_active',unique:true,fields:['active_enrollment_id']},{name:'cc_meta_business_drain_enrollment',fields:['enrollment_id']},{name:'cc_meta_business_drain_scope',fields:['scope_key','state']}]});
