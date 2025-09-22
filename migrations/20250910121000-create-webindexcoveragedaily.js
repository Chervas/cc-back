'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('WebIndexCoverageDaily', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      clinica_id: { type: Sequelize.INTEGER, allowNull: false },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      indexed_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      nonindexed_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 }
    });
    await queryInterface.addConstraint('WebIndexCoverageDaily', { fields: ['clinica_id','date'], type: 'unique', name: 'uniq_webindex_coverage' });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('WebIndexCoverageDaily');
  }
};

