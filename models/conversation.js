'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Conversation extends Model {
    static associate(models) {
      Conversation.hasMany(models.Message, { foreignKey: 'conversation_id', as: 'messages' });
      Conversation.belongsTo(models.Clinica, { foreignKey: 'clinic_id', as: 'clinica' });
    }
  }

  Conversation.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      clinic_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'Clinicas',
          key: 'id_clinica',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      channel: {
        type: DataTypes.ENUM('whatsapp', 'instagram', 'internal'),
        allowNull: false,
        defaultValue: 'internal',
      },
      contact_id: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Identificador lógico del contacto (wa_id o ig_user_id)',
      },
      patient_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'Pacientes',
          key: 'id_paciente',
        },
        onUpdate: 'SET NULL',
        onDelete: 'SET NULL',
      },
      lead_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'Leads',
          key: 'id',
        },
        onUpdate: 'SET NULL',
        onDelete: 'SET NULL',
      },
      last_message_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      unread_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      last_inbound_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Usado para validar ventana de 24h en WhatsApp',
      },
    },
    {
      sequelize,
      modelName: 'Conversation',
      tableName: 'Conversations',
      timestamps: true,
    }
  );

  return Conversation;
};
