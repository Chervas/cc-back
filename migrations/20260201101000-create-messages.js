'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('Messages', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      conversation_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Conversations',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      sender_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      direction: {
        type: Sequelize.ENUM('inbound', 'outbound'),
        allowNull: false,
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      message_type: {
        type: Sequelize.ENUM('text', 'image', 'template', 'event'),
        allowNull: false,
        defaultValue: 'text',
      },
      status: {
        type: Sequelize.ENUM('pending', 'sending', 'sent', 'delivered', 'read', 'failed'),
        allowNull: false,
        defaultValue: 'pending',
      },
      metadata: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      sent_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('Messages', ['conversation_id']);
    await queryInterface.addIndex('Messages', ['message_type']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('Messages');
  },
};
