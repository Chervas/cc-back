'use strict';

async function addIfMissing(queryInterface, tableName, columnName, definition) {
  const table = await queryInterface.describeTable(tableName);
  if (!table[columnName]) await queryInterface.addColumn(tableName, columnName, definition);
}

async function removeIfPresent(queryInterface, tableName, columnName) {
  const table = await queryInterface.describeTable(tableName);
  if (table[columnName]) await queryInterface.removeColumn(tableName, columnName);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const [tableName, size] of [
      ['LeadIntakes', 255],
      ['WebEvents', 255],
      ['WhatsAppWebOrigins', 255],
    ]) {
      await addIfMissing(queryInterface, tableName, 'gbraid', {
        type: Sequelize.STRING(size),
        allowNull: true,
      });
      await addIfMissing(queryInterface, tableName, 'wbraid', {
        type: Sequelize.STRING(size),
        allowNull: true,
      });
      await addIfMissing(queryInterface, tableName, 'ga_client_id', {
        type: Sequelize.STRING(191),
        allowNull: true,
      });
      await addIfMissing(queryInterface, tableName, 'google_ads_customer_id', {
        type: Sequelize.STRING(32),
        allowNull: true,
      });
      await addIfMissing(queryInterface, tableName, 'google_ads_campaign_id', {
        type: Sequelize.STRING(32),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    for (const tableName of ['WhatsAppWebOrigins', 'WebEvents', 'LeadIntakes']) {
      await removeIfPresent(queryInterface, tableName, 'google_ads_campaign_id');
      await removeIfPresent(queryInterface, tableName, 'google_ads_customer_id');
      await removeIfPresent(queryInterface, tableName, 'ga_client_id');
      await removeIfPresent(queryInterface, tableName, 'wbraid');
      await removeIfPresent(queryInterface, tableName, 'gbraid');
    }
  },
};
