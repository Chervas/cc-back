'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ConversationRead extends Model {
    static associate(models) {
      ConversationRead.belongsTo(models.Conversation, {
        foreignKey: 'conversation_id',
        as: 'conversation',
      });
      ConversationRead.belongsTo(models.Usuario, {
        foreignKey: 'user_id',
        targetKey: 'id_usuario',
        as: 'usuario',
      });
    }
  }

  ConversationRead.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      conversation_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      last_read_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
    },
    {
      sequelize,
      modelName: 'ConversationRead',
      tableName: 'ConversationReads',
      timestamps: true,
    }
  );

  return ConversationRead;
};
