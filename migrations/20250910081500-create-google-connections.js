'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('GoogleConnections', {
      id: { type: Sequelize.INTEGER, allowNull: false, autoIncrement: true, primaryKey: true },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      googleUserId: { type: Sequelize.STRING(128), allowNull: false },
      userEmail: { type: Sequelize.STRING(256), allowNull: true },
      accessToken: { type: Sequelize.TEXT, allowNull: false },
      refreshToken: { type: Sequelize.TEXT, allowNull: true },
      scopes: { type: Sequelize.TEXT, allowNull: true },
      expiresAt: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.fn('NOW') }
    });
    await queryInterface.addIndex('GoogleConnections', ['userId']);
    await queryInterface.addIndex('GoogleConnections', ['googleUserId']);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('GoogleConnections');
  }
};

