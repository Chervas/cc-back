'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('AutomationFlowTemplatesV2', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      template_key: {
        type: Sequelize.STRING(120),
        allowNull: false,
      },
      version: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      engine_version: {
        type: Sequelize.ENUM('v1', 'v2'),
        allowNull: false,
        defaultValue: 'v2',
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      trigger_type: {
        type: Sequelize.STRING(80),
        allowNull: false,
      },
      is_active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      is_system: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
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
      entry_node_id: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      nodes: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      published_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      published_by: {
        type: Sequelize.INTEGER,
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

    await queryInterface.addConstraint('AutomationFlowTemplatesV2', {
      fields: ['template_key', 'version'],
      type: 'unique',
      name: 'uq_automation_flow_templates_v2_template_version',
    });

    await queryInterface.addIndex('AutomationFlowTemplatesV2', ['template_key']);
    await queryInterface.addIndex('AutomationFlowTemplatesV2', ['published_at']);
    await queryInterface.addIndex('AutomationFlowTemplatesV2', ['trigger_type']);
    await queryInterface.addIndex('AutomationFlowTemplatesV2', ['engine_version']);
    await queryInterface.addIndex('AutomationFlowTemplatesV2', ['clinic_id']);
    await queryInterface.addIndex('AutomationFlowTemplatesV2', ['group_id']);
    await queryInterface.addIndex('AutomationFlowTemplatesV2', ['is_system']);
    await queryInterface.addIndex('AutomationFlowTemplatesV2', ['is_active']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeConstraint('AutomationFlowTemplatesV2', 'uq_automation_flow_templates_v2_template_version');
    await queryInterface.removeIndex('AutomationFlowTemplatesV2', ['is_active']);
    await queryInterface.removeIndex('AutomationFlowTemplatesV2', ['is_system']);
    await queryInterface.removeIndex('AutomationFlowTemplatesV2', ['group_id']);
    await queryInterface.removeIndex('AutomationFlowTemplatesV2', ['clinic_id']);
    await queryInterface.removeIndex('AutomationFlowTemplatesV2', ['engine_version']);
    await queryInterface.removeIndex('AutomationFlowTemplatesV2', ['trigger_type']);
    await queryInterface.removeIndex('AutomationFlowTemplatesV2', ['published_at']);
    await queryInterface.removeIndex('AutomationFlowTemplatesV2', ['template_key']);
    await queryInterface.dropTable('AutomationFlowTemplatesV2');

    // Compatibilidad cross-db para enum de Sequelize
    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_AutomationFlowTemplatesV2_engine_version";');
    }
  },
};
