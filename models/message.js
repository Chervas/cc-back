'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Message extends Model {
    static associate(models) {
      Message.belongsTo(models.Conversation, { foreignKey: 'conversation_id', as: 'conversation' });
    }
  }

  Message.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      conversation_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Conversations',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      sender_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Usuario interno o null si es externo',
      },
      direction: {
        type: DataTypes.ENUM('inbound', 'outbound'),
        allowNull: false,
      },
      content: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      message_type: {
        type: DataTypes.ENUM('text', 'image', 'template', 'event'),
        allowNull: false,
        defaultValue: 'text',
      },
      status: {
        type: DataTypes.ENUM('pending', 'sending', 'sent', 'delivered', 'read', 'failed'),
        allowNull: false,
        defaultValue: 'pending',
      },
      metadata: {
        type: DataTypes.JSON,
        allowNull: true,
        comment: 'wamid, template data, error codes, etc.',
      },
      sent_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'Message',
      tableName: 'Messages',
      timestamps: true,
    }
  );

  return Message;
};
