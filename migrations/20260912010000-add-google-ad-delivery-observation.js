'use strict';

const table = 'GoogleAdsAdInventory';
const column = 'deliveryObservation';

module.exports = {
  async up(qi, Sequelize) {
    const columns = await qi.describeTable(table);
    if (!columns[column]) await qi.addColumn(table, column, { type: Sequelize.JSON, allowNull: true });
    else if (columns[column].type.toUpperCase() !== 'JSON' || columns[column].allowNull !== true) {
      throw new Error(`${table}.${column}: incompatible column`);
    }
  },
  async down(qi) {
    if ((await qi.describeTable(table))[column]) await qi.removeColumn(table, column);
  },
};
