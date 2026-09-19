'use strict';
module.exports={
  async up(qi){await qi.addIndex('MetaMarketingEnrollmentRequests',['scope_key','requested_at','enrollment_id'],{name:'cc_meta_enroll_latest'});},
  async down(qi){await qi.removeIndex('MetaMarketingEnrollmentRequests','cc_meta_enroll_latest');},
};
