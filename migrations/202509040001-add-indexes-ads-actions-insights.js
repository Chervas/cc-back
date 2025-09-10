'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Helper to add index if not exists
    async function addIndexIfMissing(table, indexName, fields, options = {}) {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(1) AS cnt
         FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = :table
           AND INDEX_NAME = :indexName`,
        { replacements: { table, indexName } }
      );
      const exists = Array.isArray(rows) ? (rows[0]?.cnt > 0) : (rows.cnt > 0);
      if (!exists) {
        await queryInterface.addIndex(table, {
          name: indexName,
          fields,
          ...options,
        });
      }
    }

    // SocialAdsActionsDaily: (ad_account_id, date, entity_id, action_type)
    await addIndexIfMissing(
      'SocialAdsActionsDaily',
      'idx_actions_acc_date_entity_type',
      ['ad_account_id', 'date', 'entity_id', 'action_type']
    );

    // SocialAdsInsightsDaily: (ad_account_id, date, entity_id, publisher_platform)
    await addIndexIfMissing(
      'SocialAdsInsightsDaily',
      'idx_insights_acc_date_entity_pub',
      ['ad_account_id', 'date', 'entity_id', 'publisher_platform']
    );
  },

  async down(queryInterface, Sequelize) {
    // Helper to drop index if exists
    async function dropIndexIfExists(table, indexName) {
      const [rows] = await queryInterface.sequelize.query(
        `SELECT COUNT(1) AS cnt
         FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = :table
           AND INDEX_NAME = :indexName`,
        { replacements: { table, indexName } }
      );
      const exists = Array.isArray(rows) ? (rows[0]?.cnt > 0) : (rows.cnt > 0);
      if (exists) {
        await queryInterface.removeIndex(table, indexName);
      }
    }

    await dropIndexIfExists('SocialAdsActionsDaily', 'idx_actions_acc_date_entity_type');
    await dropIndexIfExists('SocialAdsInsightsDaily', 'idx_insights_acc_date_entity_pub');
  }
};

