'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('EmailMessages', {
      id: { type: Sequelize.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      public_id: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      stream: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'transactional' },
      provider: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'ses' },
      provider_region: { type: Sequelize.STRING(32), allowNull: true },
      provider_message_id: { type: Sequelize.STRING(255), allowNull: true },
      configuration_set: { type: Sequelize.STRING(120), allowNull: true },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'queued' },
      priority: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'normal' },
      dedupe_key: { type: Sequelize.STRING(191), allowNull: true, unique: true },
      template_key: { type: Sequelize.STRING(120), allowNull: false },
      template_version: { type: Sequelize.STRING(32), allowNull: true },
      subject_key: { type: Sequelize.STRING(120), allowNull: true },
      from_email: { type: Sequelize.STRING(320), allowNull: true },
      reply_to: { type: Sequelize.STRING(320), allowNull: true },
      recipient_email_envelope: { type: Sequelize.TEXT('long'), allowNull: true },
      recipient_hash: { type: Sequelize.CHAR(64), allowNull: false },
      recipient_domain: { type: Sequelize.STRING(255), allowNull: true },
      recipient_kind: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'external' },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      paciente_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Pacientes', key: 'id_paciente' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      usuario_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      related_type: { type: Sequelize.STRING(80), allowNull: true },
      related_id: { type: Sequelize.STRING(80), allowNull: true },
      job_request_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: 'JobRequests', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      event_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      last_event_type: { type: Sequelize.STRING(64), allowNull: true },
      last_error_code: { type: Sequelize.STRING(120), allowNull: true },
      last_error_message: { type: Sequelize.TEXT, allowNull: true },
      template_context: { type: Sequelize.JSON, allowNull: true },
      metadata: { type: Sequelize.JSON, allowNull: true },
      queued_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      sent_at: { type: Sequelize.DATE, allowNull: true },
      delivered_at: { type: Sequelize.DATE, allowNull: true },
      rejected_at: { type: Sequelize.DATE, allowNull: true },
      bounced_at: { type: Sequelize.DATE, allowNull: true },
      complained_at: { type: Sequelize.DATE, allowNull: true },
      suppressed_at: { type: Sequelize.DATE, allowNull: true },
      completed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('EmailMessages', ['stream', 'status', 'created_at'], { name: 'idx_email_messages_stream_status_created' });
    await queryInterface.addIndex('EmailMessages', ['provider_message_id'], { name: 'idx_email_messages_provider_message_id' });
    await queryInterface.addIndex('EmailMessages', ['recipient_hash', 'stream', 'status'], { name: 'idx_email_messages_recipient_stream_status' });
    await queryInterface.addIndex('EmailMessages', ['clinica_id', 'created_at'], { name: 'idx_email_messages_clinic_created' });
    await queryInterface.addIndex('EmailMessages', ['job_request_id'], { name: 'idx_email_messages_job_request' });

    await queryInterface.createTable('EmailProviderEvents', {
      id: { type: Sequelize.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      email_message_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: 'EmailMessages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      provider: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'ses' },
      provider_message_id: { type: Sequelize.STRING(255), allowNull: true },
      provider_event_id: { type: Sequelize.STRING(191), allowNull: true },
      event_type: { type: Sequelize.STRING(64), allowNull: false },
      severity: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'info' },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      payload_summary: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('EmailProviderEvents', ['provider', 'provider_event_id'], {
      name: 'idx_email_provider_events_provider_event',
      unique: true,
    });
    await queryInterface.addIndex('EmailProviderEvents', ['email_message_id', 'occurred_at'], { name: 'idx_email_provider_events_message_time' });
    await queryInterface.addIndex('EmailProviderEvents', ['event_type', 'occurred_at'], { name: 'idx_email_provider_events_type_time' });

    await queryInterface.createTable('EmailSuppressions', {
      id: { type: Sequelize.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      email_hash: { type: Sequelize.CHAR(64), allowNull: false },
      email_domain: { type: Sequelize.STRING(255), allowNull: true },
      stream: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'all' },
      scope: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'global' },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'active' },
      reason: { type: Sequelize.STRING(64), allowNull: false },
      source: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'provider_event' },
      provider_event_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: 'EmailProviderEvents', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      notes: { type: Sequelize.TEXT, allowNull: true },
      suppressed_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('EmailSuppressions', ['email_hash', 'stream', 'scope', 'status'], {
      name: 'idx_email_suppressions_hash_stream_scope',
      unique: true,
    });
    await queryInterface.addIndex('EmailSuppressions', ['clinica_id', 'status'], { name: 'idx_email_suppressions_clinic_status' });

    await queryInterface.createTable('PasswordResetTokens', {
      id: { type: Sequelize.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Usuarios', key: 'id_usuario' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      token_hash: { type: Sequelize.CHAR(64), allowNull: false, unique: true },
      token_prefix: { type: Sequelize.STRING(16), allowNull: false },
      email_hash: { type: Sequelize.CHAR(64), allowNull: false },
      email_message_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: 'EmailMessages', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'pending' },
      expires_at: { type: Sequelize.DATE, allowNull: false },
      used_at: { type: Sequelize.DATE, allowNull: true },
      requested_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      request_ip_hash: { type: Sequelize.CHAR(64), allowNull: true },
      user_agent_hash: { type: Sequelize.CHAR(64), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('PasswordResetTokens', ['user_id', 'status', 'expires_at'], { name: 'idx_password_reset_tokens_user_status_expires' });
    await queryInterface.addIndex('PasswordResetTokens', ['email_message_id'], { name: 'idx_password_reset_tokens_email_message' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('PasswordResetTokens');
    await queryInterface.dropTable('EmailSuppressions');
    await queryInterface.dropTable('EmailProviderEvents');
    await queryInterface.dropTable('EmailMessages');
  },
};
