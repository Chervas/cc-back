'use strict';

const APPOINTMENT_STATES = [
  'pendiente',
  'info_enviada',
  'info_confirmada',
  'recordatorio_enviado',
  'recordatorio_confirmado',
  'cambio_solicitado',
  'completada',
  'no_asistio',
  'cancelada',
  'reprogramada',
];

const PREVIOUS_APPOINTMENT_STATES = APPOINTMENT_STATES.filter((value) => value !== 'cambio_solicitado');

function enumSql(values) {
  return values.map((value) => `'${value}'`).join(',\n        ');
}

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      ALTER TABLE CitasPacientes
      MODIFY COLUMN estado ENUM(
        ${enumSql(APPOINTMENT_STATES)}
      ) NOT NULL DEFAULT 'pendiente';
    `);

    await queryInterface.createTable('AutomationInboundMessageClaims', {
      id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
      claim_key: { type: Sequelize.STRING(255), allowNull: false, unique: 'uq_automation_inbound_claim_key' },
      message_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: 'uq_automation_inbound_claim_message',
        references: { model: 'Messages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      conversation_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Conversations', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      clinic_id: { type: Sequelize.INTEGER, allowNull: false },
      channel: { type: Sequelize.STRING(24), allowNull: false },
      provider_message_id: { type: Sequelize.STRING(191), allowNull: true },
      owner_type: { type: Sequelize.STRING(48), allowNull: false, defaultValue: 'dispatching' },
      owner_reference_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true },
      status: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'claimed' },
      claimed_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      processed_at: { type: Sequelize.DATE, allowNull: true },
      metadata: { type: Sequelize.JSON, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('AutomationInboundMessageClaims', ['conversation_id', 'created_at'], {
      name: 'idx_automation_inbound_claim_conversation_created',
    });
    await queryInterface.addIndex('AutomationInboundMessageClaims', ['clinic_id', 'owner_type', 'status'], {
      name: 'idx_automation_inbound_claim_owner',
    });
    await queryInterface.addIndex('AutomationInboundMessageClaims', ['channel', 'provider_message_id'], {
      name: 'idx_automation_inbound_claim_provider',
    });

    await queryInterface.createTable('ConversationAutomationStates', {
      id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
      conversation_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        unique: 'uq_conversation_automation_state_conversation',
        references: { model: 'Conversations', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      clinic_id: { type: Sequelize.INTEGER, allowNull: false },
      status: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'active' },
      stage: { type: Sequelize.STRING(24), allowNull: false },
      source_message_id: { type: Sequelize.INTEGER, allowNull: true },
      first_message_at: { type: Sequelize.DATE, allowNull: true },
      deadline_at: { type: Sequelize.DATE, allowNull: true },
      execution_id: { type: Sequelize.INTEGER, allowNull: true },
      job_request_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      appointment_id: { type: Sequelize.INTEGER, allowNull: true },
      appointment_status: { type: Sequelize.STRING(40), allowNull: true },
      intent: { type: Sequelize.STRING(64), allowNull: true },
      possible_urgency: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      needs_response: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      manual_action_required: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      failure_code: { type: Sequelize.STRING(96), allowNull: true },
      completed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('ConversationAutomationStates', ['clinic_id', 'status', 'updated_at'], {
      name: 'idx_conversation_automation_state_status',
    });
    await queryInterface.addIndex('ConversationAutomationStates', ['execution_id'], {
      name: 'idx_conversation_automation_state_execution',
    });
    await queryInterface.addIndex('ConversationAutomationStates', ['source_message_id'], {
      name: 'idx_conversation_automation_state_source_message',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ConversationAutomationStates');
    await queryInterface.dropTable('AutomationInboundMessageClaims');
    await queryInterface.sequelize.query(`
      UPDATE CitasPacientes
      SET estado = 'pendiente'
      WHERE estado = 'cambio_solicitado';
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE CitasPacientes
      MODIFY COLUMN estado ENUM(
        ${enumSql(PREVIOUS_APPOINTMENT_STATES)}
      ) NOT NULL DEFAULT 'pendiente';
    `);
  },
};
