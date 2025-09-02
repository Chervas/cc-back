"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    // Añadir columnas específicas para Facebook en SocialPosts
    await queryInterface.addColumn('SocialPosts', 'impressions_count_fb', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0
    });
    await queryInterface.addColumn('SocialPosts', 'views_count_fb', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('SocialPosts', 'views_count_fb');
    await queryInterface.removeColumn('SocialPosts', 'impressions_count_fb');
  }
};

