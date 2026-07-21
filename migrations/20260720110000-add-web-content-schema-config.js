'use strict';

const TABLES = Object.freeze(['WebContentEntries', 'WebContentEntryVersions']);
const COLUMN = 'schema_config';

async function hasColumn(queryInterface, tableName, columnName) {
  const description = await queryInterface.describeTable(tableName);
  return Object.prototype.hasOwnProperty.call(description, columnName);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const tableName of TABLES) {
      if (await hasColumn(queryInterface, tableName, COLUMN)) continue;
      await queryInterface.addColumn(tableName, COLUMN, {
        type: Sequelize.JSON,
        allowNull: true,
        after: 'sources',
      });
    }
  },

  async down(queryInterface) {
    for (const tableName of [...TABLES].reverse()) {
      if (!(await hasColumn(queryInterface, tableName, COLUMN))) continue;
      await queryInterface.removeColumn(tableName, COLUMN);
    }
  },
};
