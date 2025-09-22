'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('WebPsiSnapshots', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      clinica_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      url: { type: Sequelize.STRING(1024), allowNull: false },
      fetched_at: { type: Sequelize.DATE, allowNull: false },
      performance: { type: Sequelize.INTEGER, allowNull: true },
      accessibility: { type: Sequelize.INTEGER, allowNull: true },
      lcp_ms: { type: Sequelize.INTEGER, allowNull: true },
      cls: { type: Sequelize.DECIMAL(8,4), allowNull: true },
      inp_ms: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('WebPsiSnapshots', ['clinica_id','fetched_at']);
  },
  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('WebPsiSnapshots');
  }
};

