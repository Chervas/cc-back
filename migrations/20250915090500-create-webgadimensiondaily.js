'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('WebGaDimensionDaily', {
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
      dimension_type: { type: Sequelize.STRING(64), allowNull: false },
      dimension_value: { type: Sequelize.STRING(256), allowNull: false },
      sessions: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      active_users: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      conversions: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      total_revenue: { type: Sequelize.DECIMAL(12,2), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('WebGaDimensionDaily', ['clinica_id', 'dimension_type', 'date']);
    await queryInterface.addConstraint('WebGaDimensionDaily', {
      fields: ['clinica_id', 'property_id', 'date', 'dimension_type', 'dimension_value'],
      type: 'unique',
      name: 'uniq_webgadim_clinic_property_date_dim'
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('WebGaDimensionDaily');
  }
};
