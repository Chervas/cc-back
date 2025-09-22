'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('BusinessProfileDailyMetrics', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      business_location_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'ClinicBusinessLocations', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      metric_type: { type: Sequelize.STRING(64), allowNull: false },
      metric_subtype: { type: Sequelize.STRING(64), allowNull: true },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      value: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('BusinessProfileDailyMetrics', ['clinica_id', 'metric_type', 'date'], { name: 'idx_bp_metric_clinic_type_date' });
    await queryInterface.addIndex('BusinessProfileDailyMetrics', ['business_location_id', 'date']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('BusinessProfileDailyMetrics');
  }
};
