'use strict';
const {handoverFields}=require('../src/lib/metaMarketingBusinessSchema');
module.exports=(sequelize,D)=>sequelize.define('MetaMarketingBusinessHandover',handoverFields(D),{tableName:'MetaMarketingBusinessHandovers',timestamps:false,charset:'ascii',collate:'ascii_bin',indexes:[
  {name:'cc_meta_business_new',unique:true,fields:['new_enrollment_id']},{name:'cc_meta_business_pending',unique:true,fields:['pending_scope_key']},
  {name:'cc_meta_business_state_hash',unique:true,fields:['state_hash']},{name:'cc_meta_business_code',unique:true,fields:['code_digest']},
  {name:'cc_meta_business_latest',fields:['scope_key','requested_at','handover_id']},{name:'cc_meta_business_due',fields:['state','next_attempt_at','lease_until']}]});
