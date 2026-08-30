'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('SystemNotificationSettings', {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
      },
      scope: {
        type: Sequelize.STRING(40),
        allowNull: false,
        defaultValue: 'global',
        unique: true,
      },
      enabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      panel_enabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      email_enabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      whatsapp_enabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      admin_email: {
        type: Sequelize.STRING(320),
        allowNull: true,
      },
      admin_phone: {
        type: Sequelize.STRING(40),
        allowNull: true,
      },
      whatsapp_sender_asset_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'ClinicMetaAssets',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      whatsapp_template_name: {
        type: Sequelize.STRING(100),
        allowNull: false,
        defaultValue: 'clinicaclick_admin_alerta_sistema',
      },
      whatsapp_template_language: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'es',
      },
      throttle_minutes: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 60,
      },
      event_rules: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      last_checked_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      last_tested_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.createTable('SystemNotificationDeliveries', {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
      },
      event_key: {
        type: Sequelize.STRING(120),
        allowNull: false,
      },
      severity: {
        type: Sequelize.STRING(24),
        allowNull: false,
        defaultValue: 'info',
      },
      channel: {
        type: Sequelize.STRING(24),
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING(24),
        allowNull: false,
        defaultValue: 'queued',
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      action: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      recipient_hash: {
        type: Sequelize.CHAR(64),
        allowNull: true,
      },
      recipient_label: {
        type: Sequelize.STRING(120),
        allowNull: true,
      },
      recipient_domain: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      whatsapp_sender_asset_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'ClinicMetaAssets',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      whatsapp_template_name: {
        type: Sequelize.STRING(100),
        allowNull: true,
      },
      email_message_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: {
          model: 'EmailMessages',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      job_request_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: {
          model: 'JobRequests',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      provider: {
        type: Sequelize.STRING(32),
        allowNull: true,
      },
      provider_message_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      error_code: {
        type: Sequelize.STRING(120),
        allowNull: true,
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      metadata: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      queued_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      sent_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      failed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('SystemNotificationDeliveries', ['event_key', 'channel', 'created_at'], {
      name: 'idx_system_notifications_event_channel_created',
    });
    await queryInterface.addIndex('SystemNotificationDeliveries', ['status', 'created_at'], {
      name: 'idx_system_notifications_status_created',
    });
    await queryInterface.addIndex('SystemNotificationDeliveries', ['job_request_id'], {
      name: 'idx_system_notifications_job_request',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('SystemNotificationDeliveries', 'idx_system_notifications_job_request');
    await queryInterface.removeIndex('SystemNotificationDeliveries', 'idx_system_notifications_status_created');
    await queryInterface.removeIndex('SystemNotificationDeliveries', 'idx_system_notifications_event_channel_created');
    await queryInterface.dropTable('SystemNotificationDeliveries');
    await queryInterface.dropTable('SystemNotificationSettings');
  },
};
