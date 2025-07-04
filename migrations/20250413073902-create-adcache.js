'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('AdCaches', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      ad_id: {
        type: Sequelize.STRING,
        allowNull: false
      },
      adset_id: {
        type: Sequelize.STRING,
        allowNull: false
      },
      campaign_id: {
        type: Sequelize.STRING,
        allowNull: false
      },
      ultima_actualizacion: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
    
    // Crear índice para búsquedas rápidas por ad_id
    await queryInterface.addIndex('AdCaches', ['ad_id']);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('AdCaches');
  }
};
