'use strict';
const {effectiveFields:fields}=require('../src/lib/metaMarketingCredentialSchema');
module.exports=(sequelize,D)=>sequelize.define('MetaMarketingEffectiveCredential',fields(D),{tableName:'MetaMarketingEffectiveCredentials',timestamps:false,charset:'ascii',collate:'ascii_bin',indexes:[
  {name:'cc_meta_effective_renewal',unique:true,fields:['renewal_id']},{name:'cc_meta_effective_version',unique:true,fields:['version_id']}]});
module.exports.fields=fields;
