'use strict';

// Explicit operator migration only. Never called from an application bootstrap.
module.exports = {
  async up(queryInterface) {
    for (const sql of require('../src/lib/searchConsoleAnalyticsSchema').statements()) {
      await queryInterface.sequelize.query(sql, { logging: false });
    }
  },
  async down() { throw Error('sc_analytics_evidence_preserved_use_reviewed_recovery'); },
};
