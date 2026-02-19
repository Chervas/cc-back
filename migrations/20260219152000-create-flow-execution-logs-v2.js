'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('FlowExecutionLogsV2', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      flow_execution_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'FlowExecutionsV2', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      node_id: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      node_type: {
        type: Sequelize.STRING(120),
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM('running', 'success', 'error'),
        allowNull: false,
      },
      started_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      finished_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      audit_snapshot: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      encrypted_context_diff: {
        type: Sequelize.TEXT('long'),
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('FlowExecutionLogsV2', ['flow_execution_id']);
    await queryInterface.addIndex('FlowExecutionLogsV2', ['node_id']);
    await queryInterface.addIndex('FlowExecutionLogsV2', ['status']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('FlowExecutionLogsV2', ['status']);
    await queryInterface.removeIndex('FlowExecutionLogsV2', ['node_id']);
    await queryInterface.removeIndex('FlowExecutionLogsV2', ['flow_execution_id']);
    await queryInterface.dropTable('FlowExecutionLogsV2');

    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_FlowExecutionLogsV2_status";');
    }
  },
};
