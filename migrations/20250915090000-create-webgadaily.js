'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('WebGaDaily', {
      id: { type: Sequelize.INTEGER, allowNull: false, autoIncrement: true, primaryKey: true },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      property_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'ClinicAnalyticsProperties', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      sessions: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      active_users: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      new_users: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      conversions: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      total_revenue: { type: Sequelize.DECIMAL(12,2), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('WebGaDaily', ['clinica_id', 'date']);
    await queryInterface.addIndex('WebGaDaily', ['property_id', 'date']);
    await queryInterface.addConstraint('WebGaDaily', {
      fields: ['clinica_id', 'property_id', 'date'],
      type: 'unique',
      name: 'uniq_webgadaily_clinic_property_date'
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('WebGaDaily');
  }
};
