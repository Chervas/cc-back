'use strict';
module.exports = {
  async up(qi) {
    const indexes = await qi.showIndex('GoogleDestinationAuthorizations');
    if (!indexes.some(row => row.name === 'cc_google_destination_recovery')) await qi.addIndex('GoogleDestinationAuthorizations',
      ['actor_user_id','mapping_id','scope_key','scope_digest','created_at','authorization_id'], { name: 'cc_google_destination_recovery' });
  },
  async down(qi) {
    const indexes = await qi.showIndex('GoogleDestinationAuthorizations');
    if (indexes.some(row => row.name === 'cc_google_destination_recovery')) await qi.removeIndex('GoogleDestinationAuthorizations','cc_google_destination_recovery');
  },
};
