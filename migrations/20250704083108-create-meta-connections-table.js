// backendclinicaclick/migrations/[TIMESTAMP]-create-meta-connections-table.js
'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('MetaConnections', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: {
          model: 'Usuarios', // Nombre de tu tabla de usuarios
          key: 'id_usuario',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      metaUserId: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      accessToken: {
        type: Sequelize.STRING(512),
        allowNull: false,
      },
      expiresAt: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      userName: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      userEmail: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('MetaConnections');
  }
};
