'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('WhatsAppWebOrigins', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      ref: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Clinicas',
          key: 'id_clinica',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      group_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'GruposClinicas',
          key: 'id_grupo',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      domain: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      page_url: {
        type: Sequelize.STRING(1024),
        allowNull: true,
      },
      referrer: {
        type: Sequelize.STRING(1024),
        allowNull: true,
      },
      utm_source: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      utm_medium: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      utm_campaign: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      utm_content: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      utm_term: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      gclid: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      fbclid: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      ttclid: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      event_id: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      expires_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      used_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      used_conversation_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Conversations',
          key: 'id',
        },
        onUpdate: 'SET NULL',
        onDelete: 'SET NULL',
      },
      used_message_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Messages',
          key: 'id',
        },
        onUpdate: 'SET NULL',
        onDelete: 'SET NULL',
      },
      from_phone: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      phone_number_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      metadata: {
        type: Sequelize.JSON,
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

    await queryInterface.addIndex('WhatsAppWebOrigins', ['ref'], {
      unique: true,
      name: 'whatsapp_web_origins_ref_uq',
    });
    await queryInterface.addIndex('WhatsAppWebOrigins', ['clinic_id', 'createdAt'], {
      name: 'whatsapp_web_origins_clinic_created_idx',
    });
    await queryInterface.addIndex('WhatsAppWebOrigins', ['group_id', 'createdAt'], {
      name: 'whatsapp_web_origins_group_created_idx',
    });
    await queryInterface.addIndex('WhatsAppWebOrigins', ['expires_at'], {
      name: 'whatsapp_web_origins_expires_idx',
    });
    await queryInterface.addIndex('WhatsAppWebOrigins', ['used_at'], {
      name: 'whatsapp_web_origins_used_idx',
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('WhatsAppWebOrigins');
  },
};

