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
    await addIfMissing(queryInterface, 'GoogleAdsInsightsDaily', 'allConversions', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: false,
      defaultValue: 0,
    });
    await addIfMissing(queryInterface, 'GoogleAdsInsightsDaily', 'allConversionsValue', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: false,
      defaultValue: 0,
    });
  },

  async down(queryInterface) {
    await removeIfPresent(queryInterface, 'GoogleAdsInsightsDaily', 'allConversionsValue');
    await removeIfPresent(queryInterface, 'GoogleAdsInsightsDaily', 'allConversions');
  },
};
