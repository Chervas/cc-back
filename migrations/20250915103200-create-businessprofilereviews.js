'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('BusinessProfileReviews', {
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
      review_name: { type: Sequelize.STRING(256), allowNull: false, unique: true },
      reviewer_name: { type: Sequelize.STRING(256), allowNull: true },
      reviewer_profile_photo_url: { type: Sequelize.STRING(1024), allowNull: true },
      star_rating: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      comment: { type: Sequelize.TEXT, allowNull: true },
      create_time: { type: Sequelize.DATE, allowNull: true },
      update_time: { type: Sequelize.DATE, allowNull: true },
      review_state: { type: Sequelize.STRING(64), allowNull: true },
      is_new: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_negative: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      reply_comment: { type: Sequelize.TEXT, allowNull: true },
      reply_update_time: { type: Sequelize.DATE, allowNull: true },
      has_reply: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      raw_payload: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('BusinessProfileReviews', ['clinica_id', 'star_rating']);
    await queryInterface.addIndex('BusinessProfileReviews', ['business_location_id', 'create_time']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('BusinessProfileReviews');
  }
};
