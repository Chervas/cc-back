'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('WebScDailyAgg', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      clinica_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      queries_top10: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      queries_top3: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addConstraint('WebScDailyAgg', { fields: ['clinica_id','date'], type: 'unique', name: 'uniq_webscagg_clinic_date' });
  },
  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('WebScDailyAgg');
  }
};

