'use strict';

module.exports = {
  async up(qi, Sequelize) {
    const table = 'BusinessProfileReviews';
    const columns = await qi.describeTable(table);
    for (const name of ['first_seen_at', 'last_seen_at', 'google_missing_at']) {
      if (!columns[name]) await qi.addColumn(table, name, { type: Sequelize.DATE, allowNull: true });
    }
    const indexes = await qi.showIndex(table);
    if (!indexes.some(index => index.name === 'bpr_location_presence')) {
      await qi.addIndex(table, ['business_location_id', 'google_missing_at'], { name: 'bpr_location_presence' });
    }
  },
  async down() {
    throw Error('Preserve Google review observations and historical attribution');
  },
};
