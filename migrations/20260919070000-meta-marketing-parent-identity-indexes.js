'use strict';
// Additive lookup paths for IG -> page claims and durable withdrawal history.
// No data changes; never erase a withdrawal to make an asset look unassigned.
module.exports={
  async up(qi){
    await qi.addIndex('MetaMarketingBrokerBindings',['parent_page_id'],{name:'cc_meta_marketing_parent'});
    await qi.addIndex('MetaMarketingBrokerRevocations',['parent_page_id'],{name:'cc_meta_revoke_parent'});
  },
  async down(qi){
    await qi.removeIndex('MetaMarketingBrokerRevocations','cc_meta_revoke_parent');
    await qi.removeIndex('MetaMarketingBrokerBindings','cc_meta_marketing_parent');
  },
};
