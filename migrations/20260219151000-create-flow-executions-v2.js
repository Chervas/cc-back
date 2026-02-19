'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('FlowExecutionsV2', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      idempotency_key: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      template_version_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'AutomationFlowTemplatesV2', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      engine_version: {
        type: Sequelize.ENUM('v1', 'v2'),
        allowNull: false,
        defaultValue: 'v2',
      },
      status: {
        type: Sequelize.ENUM('running', 'waiting', 'completed', 'failed', 'paused', 'cancelled', 'dead_letter'),
        allowNull: false,
        defaultValue: 'running',
      },
      context: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      current_node_id: {
        type: Sequelize.STRING(32),
        allowNull: true,
      },
      trigger_type: {
        type: Sequelize.STRING(80),
        allowNull: false,
      },
      trigger_entity_type: {
        type: Sequelize.STRING(80),
        allowNull: true,
      },
      trigger_entity_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      group_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      last_error: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_by: {
        type: Sequelize.INTEGER,
        allowNull: false,
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
        onUpdate: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addConstraint('FlowExecutionsV2', {
      fields: ['idempotency_key'],
      type: 'unique',
      name: 'uq_flow_executions_v2_idempotency_key',
    });

    await queryInterface.addIndex('FlowExecutionsV2', ['template_version_id']);
    await queryInterface.addIndex('FlowExecutionsV2', ['status']);
    await queryInterface.addIndex('FlowExecutionsV2', ['clinic_id']);
    await queryInterface.addIndex('FlowExecutionsV2', ['group_id']);
    await queryInterface.addIndex('FlowExecutionsV2', ['trigger_entity_type', 'trigger_entity_id']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeConstraint('FlowExecutionsV2', 'uq_flow_executions_v2_idempotency_key');
    await queryInterface.removeIndex('FlowExecutionsV2', ['trigger_entity_type', 'trigger_entity_id']);
    await queryInterface.removeIndex('FlowExecutionsV2', ['group_id']);
    await queryInterface.removeIndex('FlowExecutionsV2', ['clinic_id']);
    await queryInterface.removeIndex('FlowExecutionsV2', ['status']);
    await queryInterface.removeIndex('FlowExecutionsV2', ['template_version_id']);
    await queryInterface.dropTable('FlowExecutionsV2');

    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_FlowExecutionsV2_engine_version";');
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_FlowExecutionsV2_status";');
    }
  },
};
