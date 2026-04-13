'use strict';

const TABLE_NAME = 'BusinessProfilePosts';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn(TABLE_NAME, 'summary', {
      type: Sequelize.TEXT,
      allowNull: true
    });
    await queryInterface.changeColumn(TABLE_NAME, 'call_to_action_url', {
      type: Sequelize.TEXT,
      allowNull: true
    });
    await queryInterface.changeColumn(TABLE_NAME, 'media_url', {
      type: Sequelize.TEXT,
      allowNull: true
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn(TABLE_NAME, 'summary', {
      type: Sequelize.STRING(1024),
      allowNull: true
    });
    await queryInterface.changeColumn(TABLE_NAME, 'call_to_action_url', {
      type: Sequelize.STRING(1024),
      allowNull: true
    });
    await queryInterface.changeColumn(TABLE_NAME, 'media_url', {
      type: Sequelize.STRING(1024),
      allowNull: true
    });
  }
};
