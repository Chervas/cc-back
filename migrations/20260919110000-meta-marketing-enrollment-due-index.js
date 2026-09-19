'use strict';
module.exports={
  async up(qi){
    await qi.sequelize.query(`ALTER TABLE MetaMarketingEnrollmentRequests
      ADD COLUMN delivery_due_at DATETIME(3) GENERATED ALWAYS AS
        (CASE WHEN state = 'revoked' THEN NULL ELSE next_attempt_at END) STORED,
      ADD INDEX cc_meta_enroll_due (delivery_due_at,enrollment_id)`);
  },
  async down(qi){
    await qi.removeIndex('MetaMarketingEnrollmentRequests','cc_meta_enroll_due');
    await qi.removeColumn('MetaMarketingEnrollmentRequests','delivery_due_at');
  },
};
