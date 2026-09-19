'use strict';
const NAME = 'cc_google_receipt_review';
module.exports = {
  async up(qi) {
    if (!(await qi.showIndex('GoogleConversionSubmissions')).some(row => row.name === NAME)) {
      await qi.addIndex('GoogleConversionSubmissions', ['mapping_id', 'scope_digest', 'delivery_digest', 'created_at', 'submission_id'], { name: NAME });
    }
  },
  async down(qi) {
    // Disable the review consumer before removing its required index. Preserve receipts.
    if ((await qi.showIndex('GoogleConversionSubmissions')).some(row => row.name === NAME)) await qi.removeIndex('GoogleConversionSubmissions', NAME);
  },
};
