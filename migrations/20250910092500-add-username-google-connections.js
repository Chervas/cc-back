'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    try {
      await queryInterface.addColumn('GoogleConnections', 'userName', {
        type: Sequelize.STRING(256),
        allowNull: true
      });
    } catch (e) {
      console.warn('⚠️ add userName to GoogleConnections:', e.message);
    }
  },

  down: async (queryInterface, Sequelize) => {
    try {
      await queryInterface.removeColumn('GoogleConnections', 'userName');
    } catch (e) {
      console.warn('⚠️ remove userName from GoogleConnections:', e.message);
    }
  }
};

