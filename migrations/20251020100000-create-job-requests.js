'use strict';

const TABLE_NAME = 'JobRequests';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable(TABLE_NAME, {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      type: {
        type: Sequelize.STRING(80),
        allowNull: false
      },
      priority: {
        type: Sequelize.ENUM('critical', 'high', 'normal', 'low'),
        allowNull: false,
        defaultValue: 'normal'
      },
      status: {
        type: Sequelize.ENUM('pending', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled'),
        allowNull: false,
        defaultValue: 'pending'
      },
      origin: {
        type: Sequelize.STRING(80),
        allowNull: false,
        defaultValue: 'manual'
      },
      payload: {
        type: Sequelize.JSON,
        allowNull: false
      },
      requested_by: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      requested_by_name: {
        type: Sequelize.STRING(120),
        allowNull: true
      },
      requested_by_role: {
        type: Sequelize.STRING(80),
        allowNull: true
      },
      attempts: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0
      },
      max_attempts: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 5
      },
      last_attempt_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      next_run_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      sync_log_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      result_summary: {
        type: Sequelize.JSON,
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW')
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn('NOW')
      }
    });

    await queryInterface.addIndex(TABLE_NAME, ['status', 'priority']);
    await queryInterface.addIndex(TABLE_NAME, ['priority', 'created_at']);
    await queryInterface.addIndex(TABLE_NAME, ['next_run_at']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable(TABLE_NAME);
  }
};
