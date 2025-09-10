'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Add column if missing
    const table = 'SocialAdsActionsDaily';
    const [cols] = await queryInterface.sequelize.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = 'publisher_platform'`,
      { replacements: { table } }
    );
    const hasCol = Array.isArray(cols) ? cols.length > 0 : !!cols?.length;
    if (!hasCol) {
      await queryInterface.addColumn(table, 'publisher_platform', {
        type: Sequelize.STRING(64),
        allowNull: true,
        after: 'action_destination'
      });
    }

    // Add composite index including publisher_platform
    const indexName = 'idx_actions_acc_date_entity_type_plat';
    const [idx] = await queryInterface.sequelize.query(
      `SELECT COUNT(1) AS cnt FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND INDEX_NAME = :indexName`,
      { replacements: { table, indexName } }
    );
    const exists = Array.isArray(idx) ? (idx[0]?.cnt > 0) : (idx.cnt > 0);
    if (!exists) {
      await queryInterface.addIndex(table, {
        name: indexName,
        fields: ['ad_account_id','date','entity_id','action_type','publisher_platform']
      });
    }
  },
  async down(queryInterface, Sequelize) {
    const table = 'SocialAdsActionsDaily';
    // Drop index
    try { await queryInterface.removeIndex(table, 'idx_actions_acc_date_entity_type_plat'); } catch {}
    // Drop column
    try { await queryInterface.removeColumn(table, 'publisher_platform'); } catch {}
  }
};

