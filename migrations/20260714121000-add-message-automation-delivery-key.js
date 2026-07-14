'use strict';

const COLUMN = 'automation_delivery_key';
const INDEX = 'uq_messages_automation_delivery_key';

async function hasColumn(queryInterface) {
  const definition = await queryInterface.describeTable('Messages');
  return !!definition[COLUMN];
}

async function hasIndex(queryInterface) {
  const indexes = await queryInterface.showIndex('Messages');
  return indexes.some((index) => index.name === INDEX);
}

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await hasColumn(queryInterface))) {
      await queryInterface.addColumn('Messages', COLUMN, {
        type: Sequelize.STRING(191),
        allowNull: true,
        comment: 'Clave idempotente global para una entrega materializada por Automatizaciones V2',
      });
    }
    if (!(await hasIndex(queryInterface))) {
      await queryInterface.addIndex('Messages', [COLUMN], {
        name: INDEX,
        unique: true,
      });
    }
  },

  async down(queryInterface) {
    if (await hasIndex(queryInterface)) {
      await queryInterface.removeIndex('Messages', INDEX);
    }
    if (await hasColumn(queryInterface)) {
      await queryInterface.removeColumn('Messages', COLUMN);
    }
  },
};
