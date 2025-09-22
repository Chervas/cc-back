'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('ClinicBusinessLocations', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      google_connection_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'GoogleConnections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      location_name: { type: Sequelize.STRING(256), allowNull: true },
      location_id: { type: Sequelize.STRING(256), allowNull: false },
      store_code: { type: Sequelize.STRING(128), allowNull: true },
      primary_category: { type: Sequelize.STRING(256), allowNull: true },
      sync_status: { type: Sequelize.STRING(32), allowNull: true },
      is_verified: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_suspended: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      raw_payload: { type: Sequelize.JSON, allowNull: true },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      last_synced_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('ClinicBusinessLocations', ['clinica_id']);
    await queryInterface.addIndex('ClinicBusinessLocations', ['location_id'], { unique: true, name: 'uniq_clinicbusiness_locationid' });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('ClinicBusinessLocations');
  }
};
