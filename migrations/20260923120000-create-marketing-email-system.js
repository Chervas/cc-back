'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const timestamps = {
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    };
    const scopeColumns = {
      scope_type: { type: Sequelize.STRING(16), allowNull: false },
      scope_key: { type: Sequelize.STRING(64), allowNull: false },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      grupo_clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
    };

    await queryInterface.changeColumn('EmailMessages', 'from_email', {
      type: Sequelize.STRING(512),
      allowNull: true,
    });

    await queryInterface.createTable('EmailSendingDomains', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      public_id: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      ...scopeColumns,
      domain: { type: Sequelize.STRING(255), allowNull: false },
      identity_name: { type: Sequelize.STRING(320), allowNull: false },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'pending' },
      verification_status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'pending' },
      dkim_status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'pending' },
      spf_status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'pending' },
      dmarc_status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'unknown' },
      mail_from_domain: { type: Sequelize.STRING(255), allowNull: true },
      mail_from_status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'not_configured' },
      dns_records: { type: Sequelize.JSON, allowNull: false },
      provider_snapshot: { type: Sequelize.JSON, allowNull: true },
      last_error_code: { type: Sequelize.STRING(120), allowNull: true },
      last_error_message: { type: Sequelize.STRING(1000), allowNull: true },
      checked_at: { type: Sequelize.DATE, allowNull: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('EmailSendingDomains', ['domain'], {
      name: 'uq_email_sending_domain_owner',
      unique: true,
    });
    await queryInterface.addIndex('EmailSendingDomains', ['verification_status', 'checked_at'], {
      name: 'idx_email_sending_domain_verification',
    });

    await queryInterface.createTable('EmailSenderIdentities', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      public_id: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      ...scopeColumns,
      domain_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: 'EmailSendingDomains', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      email: { type: Sequelize.STRING(320), allowNull: false },
      display_name: { type: Sequelize.STRING(160), allowNull: false },
      reply_to: { type: Sequelize.STRING(320), allowNull: true },
      status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'active' },
      verification_status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'pending' },
      is_default: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('EmailSenderIdentities', ['scope_key', 'email'], {
      name: 'uq_email_sender_scope',
      unique: true,
    });
    await queryInterface.addIndex('EmailSenderIdentities', ['scope_key', 'status', 'is_default'], {
      name: 'idx_email_sender_scope_status',
    });

    await queryInterface.createTable('MarketingEmailTemplates', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      public_id: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      ...scopeColumns,
      name: { type: Sequelize.STRING(160), allowNull: false },
      status: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'draft' },
      subject: { type: Sequelize.STRING(160), allowNull: false },
      preheader: { type: Sequelize.STRING(255), allowNull: true },
      layout_key: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'classic' },
      design: { type: Sequelize.JSON, allowNull: false },
      rendered_html: { type: Sequelize.TEXT('long'), allowNull: true },
      rendered_text: { type: Sequelize.TEXT('long'), allowNull: true },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      updated_by: { type: Sequelize.INTEGER, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('MarketingEmailTemplates', ['scope_key', 'status', 'updated_at'], {
      name: 'idx_marketing_email_template_scope',
    });

    await queryInterface.createTable('MarketingEmailUnsubscribes', {
      id: { type: Sequelize.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
      token_hash: { type: Sequelize.CHAR(64), allowNull: false, unique: true },
      email_hash: { type: Sequelize.CHAR(64), allowNull: false },
      scope_key: { type: Sequelize.STRING(64), allowNull: false },
      clinica_id: { type: Sequelize.INTEGER, allowNull: true },
      grupo_clinica_id: { type: Sequelize.INTEGER, allowNull: true },
      list_id: { type: Sequelize.INTEGER, allowNull: true },
      item_id: { type: Sequelize.INTEGER, allowNull: true },
      status: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'issued' },
      unsubscribed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('MarketingEmailUnsubscribes', ['scope_key', 'email_hash', 'status'], {
      name: 'idx_marketing_email_unsubscribe_contact',
    });

    await queryInterface.addColumn('MarketingPatientLists', 'email_template_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'MarketingEmailTemplates', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('MarketingPatientLists', 'email_sender_identity_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'EmailSenderIdentities', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('MarketingPatientLists', 'email_dispatch', {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await queryInterface.addColumn('MarketingPatientListItems', 'channel_status', {
      type: Sequelize.JSON,
      allowNull: true,
    });
    await queryInterface.addColumn('MarketingPatientListItems', 'email_message_id', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'EmailMessages', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('MarketingPatientListItems', 'email_message_id');
    await queryInterface.removeColumn('MarketingPatientListItems', 'channel_status');
    await queryInterface.removeColumn('MarketingPatientLists', 'email_dispatch');
    await queryInterface.removeColumn('MarketingPatientLists', 'email_sender_identity_id');
    await queryInterface.removeColumn('MarketingPatientLists', 'email_template_id');
    await queryInterface.dropTable('MarketingEmailUnsubscribes');
    await queryInterface.dropTable('MarketingEmailTemplates');
    await queryInterface.dropTable('EmailSenderIdentities');
    await queryInterface.dropTable('EmailSendingDomains');
    await queryInterface.changeColumn('EmailMessages', 'from_email', {
      type: Sequelize.STRING(320),
      allowNull: true,
    });
  },
};
