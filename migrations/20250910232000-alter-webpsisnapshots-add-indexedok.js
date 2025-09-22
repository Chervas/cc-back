'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('WebPsiSnapshots', 'indexed_ok', { type: Sequelize.BOOLEAN, allowNull: true });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('WebPsiSnapshots', 'indexed_ok');
  }
};

