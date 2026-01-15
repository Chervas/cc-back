'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('LeadIntakes', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      grupo_clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      campana_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Campanas', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      channel: {
        type: Sequelize.ENUM('paid', 'organic', 'unknown'),
        allowNull: false,
        defaultValue: 'unknown'
      },
      source: {
        type: Sequelize.ENUM('meta_ads', 'google_ads', 'web', 'whatsapp', 'call_click', 'tiktok_ads', 'seo', 'direct', 'local_services'),
        allowNull: true
      },
      source_detail: { type: Sequelize.STRING(512), allowNull: true },
      clinic_match_source: { type: Sequelize.STRING(64), allowNull: true },
      clinic_match_value: { type: Sequelize.STRING(256), allowNull: true },
      utm_source: { type: Sequelize.STRING(128), allowNull: true },
      utm_medium: { type: Sequelize.STRING(128), allowNull: true },
      utm_campaign: { type: Sequelize.STRING(128), allowNull: true },
      utm_content: { type: Sequelize.STRING(128), allowNull: true },
      utm_term: { type: Sequelize.STRING(128), allowNull: true },
      gclid: { type: Sequelize.STRING(128), allowNull: true },
      fbclid: { type: Sequelize.STRING(128), allowNull: true },
      ttclid: { type: Sequelize.STRING(128), allowNull: true },
      referrer: { type: Sequelize.STRING(512), allowNull: true },
      page_url: { type: Sequelize.STRING(1024), allowNull: true },
      landing_url: { type: Sequelize.STRING(1024), allowNull: true },
      user_agent: { type: Sequelize.STRING(512), allowNull: true },
      ip: { type: Sequelize.STRING(64), allowNull: true },
      event_id: { type: Sequelize.STRING(128), allowNull: true },
      nombre: { type: Sequelize.STRING(255), allowNull: true },
      email: { type: Sequelize.STRING(255), allowNull: true },
      email_hash: { type: Sequelize.STRING(128), allowNull: true },
      telefono: { type: Sequelize.STRING(64), allowNull: true },
      phone_hash: { type: Sequelize.STRING(128), allowNull: true },
      notas: { type: Sequelize.TEXT, allowNull: true },
      status_lead: {
        type: Sequelize.ENUM('nuevo', 'contactado', 'convertido', 'descartado'),
        allowNull: false,
        defaultValue: 'nuevo'
      },
      consentimiento_canal: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('LeadIntakes', { name: 'idx_leadintakes_clinica_created', fields: ['clinica_id', 'created_at'] });
    await queryInterface.addIndex('LeadIntakes', { name: 'idx_leadintakes_grupo_created', fields: ['grupo_clinica_id', 'created_at'] });
    await queryInterface.addIndex('LeadIntakes', { name: 'idx_leadintakes_channel_source', fields: ['channel', 'source', 'created_at'] });
    await queryInterface.addIndex('LeadIntakes', { name: 'idx_leadintakes_status', fields: ['status_lead'] });
    await queryInterface.addIndex('LeadIntakes', { name: 'idx_leadintakes_campaign', fields: ['campana_id'] });
    await queryInterface.addIndex('LeadIntakes', { name: 'idx_leadintakes_phone_hash', fields: ['phone_hash'] });
    await queryInterface.addIndex('LeadIntakes', { name: 'idx_leadintakes_email_hash', fields: ['email_hash'] });
    await queryInterface.addIndex('LeadIntakes', { name: 'uniq_leadintakes_event_id', fields: ['event_id'], unique: true });

    await queryInterface.createTable('LeadAttributionAudits', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
      lead_intake_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'LeadIntakes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      raw_payload: { type: Sequelize.JSON, allowNull: true },
      attribution_steps: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('LeadAttributionAudits', {
      name: 'idx_lead_attribution_audit_lead_id',
      fields: ['lead_intake_id']
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('LeadAttributionAudits', 'idx_lead_attribution_audit_lead_id');
    await queryInterface.dropTable('LeadAttributionAudits');

    await queryInterface.removeIndex('LeadIntakes', 'uniq_leadintakes_event_id');
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_email_hash');
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_phone_hash');
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_campaign');
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_status');
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_channel_source');
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_grupo_created');
    await queryInterface.removeIndex('LeadIntakes', 'idx_leadintakes_clinica_created');

    await queryInterface.dropTable('LeadIntakes');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_LeadIntakes_channel";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_LeadIntakes_source";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_LeadIntakes_status_lead";');
  }
};
