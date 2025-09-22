'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('BusinessProfilePosts', {
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
      post_name: { type: Sequelize.STRING(256), allowNull: false, unique: true },
      summary: { type: Sequelize.STRING(1024), allowNull: true },
      topic_type: { type: Sequelize.STRING(64), allowNull: true },
      call_to_action_type: { type: Sequelize.STRING(64), allowNull: true },
      call_to_action_url: { type: Sequelize.STRING(1024), allowNull: true },
      media_url: { type: Sequelize.STRING(1024), allowNull: true },
      create_time: { type: Sequelize.DATE, allowNull: true },
      update_time: { type: Sequelize.DATE, allowNull: true },
      event_start_time: { type: Sequelize.DATE, allowNull: true },
      event_end_time: { type: Sequelize.DATE, allowNull: true },
      visibility_state: { type: Sequelize.STRING(64), allowNull: true },
      raw_payload: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('BusinessProfilePosts', ['clinica_id', 'create_time']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('BusinessProfilePosts');
  }
};
