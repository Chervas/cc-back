'use strict';
module.exports={
  async up(qi){await qi.sequelize.query('ALTER TABLE MetaMarketingEnrollmentRequests ADD COLUMN prepare_sent_at DATETIME(3) NULL, ADD COLUMN activate_sent_at DATETIME(3) NULL');},
  async down(qi){
    const [rows]=await qi.sequelize.query('SELECT COUNT(*) n FROM MetaMarketingEnrollmentRequests WHERE prepare_sent_at IS NOT NULL OR activate_sent_at IS NOT NULL');
    if(Number(rows[0].n))throw Error('Preserve Meta enrollment delivery uncertainty');
    await qi.removeColumn('MetaMarketingEnrollmentRequests','activate_sent_at');await qi.removeColumn('MetaMarketingEnrollmentRequests','prepare_sent_at');
  },
};
