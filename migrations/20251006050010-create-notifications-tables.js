'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Notifications', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'Usuarios',
          key: 'id_usuario'
        },
        onDelete: 'CASCADE'
      },
      role: {
        type: Sequelize.STRING(64),
        allowNull: true
      },
      subrole: {
        type: Sequelize.STRING(128),
        allowNull: false,
        defaultValue: ''
      },
      category: {
        type: Sequelize.STRING(64),
        allowNull: false
      },
      event: {
        type: Sequelize.STRING(128),
        allowNull: false
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      message: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      icon: {
        type: Sequelize.STRING(128),
        allowNull: true
      },
      level: {
        type: Sequelize.STRING(32),
        allowNull: true
      },
      data: {
        type: Sequelize.JSON,
        allowNull: true
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'Clinicas',
          key: 'id_clinica'
        },
        onDelete: 'SET NULL'
      },
      is_read: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      read_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.createTable('NotificationPreferences', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      role: {
        type: Sequelize.STRING(64),
        allowNull: false
      },
      subrole: {
        type: Sequelize.STRING(128),
        allowNull: false,
        defaultValue: ''
      },
      category: {
        type: Sequelize.STRING(64),
        allowNull: false
      },
      event: {
        type: Sequelize.STRING(128),
        allowNull: false
      },
      enabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('NotificationPreferences', ['role', 'subrole', 'event'], {
      name: 'idx_notification_preferences_role_event',
      unique: true
    });

    await queryInterface.addIndex('Notifications', ['user_id', 'is_read']);
    await queryInterface.addIndex('Notifications', ['created_at']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Notifications', ['user_id', 'is_read']);
    await queryInterface.removeIndex('Notifications', ['created_at']);
    await queryInterface.removeIndex('NotificationPreferences', 'idx_notification_preferences_role_event');
    await queryInterface.dropTable('NotificationPreferences');
    await queryInterface.dropTable('Notifications');
  }
};
