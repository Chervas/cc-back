'use strict';
// Credential versions do not replace an enrollment, asset claim or revocation.
module.exports={
  async up(queryInterface,D){
    const schema=require('../src/lib/metaMarketingCredentialSchema');
    await queryInterface.createTable('MetaMarketingCredentialRenewals',schema.renewalFields(D),{charset:'ascii',collate:'ascii_bin'});
    for(const [name,columns,unique]of[
      ['cc_meta_renewal_pending',['pending_enrollment_id'],true],['cc_meta_renewal_state',['state_hash'],true],['cc_meta_renewal_code',['code_digest'],true],
      ['cc_meta_renewal_latest',['enrollment_id','requested_at','renewal_id'],false],['cc_meta_renewal_delivery',['state','next_attempt_at','lease_until'],false]
    ])await queryInterface.addIndex('MetaMarketingCredentialRenewals',columns,{name,unique});
    await queryInterface.createTable('MetaMarketingEffectiveCredentials',schema.effectiveFields(D),{charset:'ascii',collate:'ascii_bin'});
    for(const [name,column]of[['cc_meta_effective_renewal','renewal_id'],['cc_meta_effective_version','version_id']])
      await queryInterface.addIndex('MetaMarketingEffectiveCredentials',[column],{name,unique:true});
  },
  async down(){throw Error('meta_credential_renewal_history_must_be_preserved');}
};
