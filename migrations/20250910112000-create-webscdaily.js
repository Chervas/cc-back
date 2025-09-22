'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('WebScDaily', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      clinica_id: { type: Sequelize.INTEGER, allowNull: false, references: { model: 'Clinicas', key: 'id_clinica' }, onUpdate: 'CASCADE', onDelete: 'CASCADE' },
      site_url: { type: Sequelize.STRING(512), allowNull: true },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      clicks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      impressions: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      ctr: { type: Sequelize.DECIMAL(8,6), allowNull: false, defaultValue: 0 },
      position: { type: Sequelize.DECIMAL(8,3), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('WebScDaily', ['clinica_id','date']);
    await queryInterface.addConstraint('WebScDaily', { fields: ['clinica_id','site_url','date'], type: 'unique', name: 'uniq_websc_clinic_site_date' });
  },
  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('WebScDaily');
  }
};

