'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('FlowExecutionsV2', 'wait_until', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addColumn('FlowExecutionsV2', 'waiting_meta', {
      type: Sequelize.JSON,
      allowNull: true,
    });

    await queryInterface.addIndex('FlowExecutionsV2', ['wait_until']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('FlowExecutionsV2', ['wait_until']);
    await queryInterface.removeColumn('FlowExecutionsV2', 'waiting_meta');
    await queryInterface.removeColumn('FlowExecutionsV2', 'wait_until');
  },
};
