'use strict';
const {renewalFields:fields}=require('../src/lib/metaMarketingCredentialSchema');
module.exports=(sequelize,D)=>sequelize.define('MetaMarketingCredentialRenewal',fields(D),{tableName:'MetaMarketingCredentialRenewals',timestamps:false,charset:'ascii',collate:'ascii_bin',indexes:[
  {name:'cc_meta_renewal_pending',unique:true,fields:['pending_enrollment_id']},{name:'cc_meta_renewal_state',unique:true,fields:['state_hash']},
  {name:'cc_meta_renewal_code',unique:true,fields:['code_digest']},{name:'cc_meta_renewal_latest',fields:['enrollment_id','requested_at','renewal_id']},
  {name:'cc_meta_renewal_delivery',fields:['state','next_attempt_at','lease_until']}]});
module.exports.fields=fields;
