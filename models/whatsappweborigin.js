'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class WhatsAppWebOrigin extends Model {
    static associate(models) {
      if (models.Clinica) {
        WhatsAppWebOrigin.belongsTo(models.Clinica, {
          foreignKey: 'clinic_id',
          targetKey: 'id_clinica',
          as: 'clinica',
        });
      }
      if (models.GrupoClinica) {
        WhatsAppWebOrigin.belongsTo(models.GrupoClinica, {
          foreignKey: 'group_id',
          targetKey: 'id_grupo',
          as: 'grupoClinica',
        });
      }
      if (models.Conversation) {
        WhatsAppWebOrigin.belongsTo(models.Conversation, {
          foreignKey: 'used_conversation_id',
          as: 'usedConversation',
        });
      }
      if (models.Message) {
        WhatsAppWebOrigin.belongsTo(models.Message, {
          foreignKey: 'used_message_id',
          as: 'usedMessage',
        });
      }
    }
  }

  WhatsAppWebOrigin.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      ref: {
        type: DataTypes.STRING(64),
        allowNull: false,
        unique: true,
      },
      clinic_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      group_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      domain: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      page_url: {
        type: DataTypes.STRING(1024),
        allowNull: true,
      },
      referrer: {
        type: DataTypes.STRING(1024),
        allowNull: true,
      },
      utm_source: {
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      utm_medium: {
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      utm_campaign: {
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      utm_content: {
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      utm_term: {
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      gclid: {
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      fbclid: {
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      ttclid: {
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      event_id: {
        type: DataTypes.STRING(128),
        allowNull: true,
      },
      expires_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      used_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      used_conversation_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      used_message_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      from_phone: {
        type: DataTypes.STRING(64),
        allowNull: true,
      },
      phone_number_id: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      metadata: {
        type: DataTypes.JSON,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'WhatsAppWebOrigin',
      tableName: 'WhatsAppWebOrigins',
      timestamps: true,
    }
  );

  return WhatsAppWebOrigin;
};

