'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('WebEvents', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      clinic_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'Clinicas', key: 'id_clinica' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      group_id: { type: Sequelize.INTEGER, allowNull: true, references: { model: 'GruposClinicas', key: 'id_grupo' }, onUpdate: 'CASCADE', onDelete: 'SET NULL' },
      event_name: { type: Sequelize.STRING(80), allowNull: false },
      event_type: { type: Sequelize.STRING(80), allowNull: true },
      event_id: { type: Sequelize.STRING(128), allowNull: true },
      session_id: { type: Sequelize.STRING(128), allowNull: true },
      visitor_id: { type: Sequelize.STRING(128), allowNull: true },
      domain: { type: Sequelize.STRING(255), allowNull: true },
      page_url: { type: Sequelize.STRING(1024), allowNull: true },
      page_path: { type: Sequelize.STRING(512), allowNull: true },
      page_title: { type: Sequelize.STRING(512), allowNull: true },
      referrer: { type: Sequelize.STRING(1024), allowNull: true },
      utm_source: { type: Sequelize.STRING(128), allowNull: true },
      utm_medium: { type: Sequelize.STRING(128), allowNull: true },
      utm_campaign: { type: Sequelize.STRING(255), allowNull: true },
      utm_content: { type: Sequelize.STRING(255), allowNull: true },
      utm_term: { type: Sequelize.STRING(255), allowNull: true },
      gclid: { type: Sequelize.STRING(255), allowNull: true },
      fbclid: { type: Sequelize.STRING(255), allowNull: true },
      ttclid: { type: Sequelize.STRING(255), allowNull: true },
      msclkid: { type: Sequelize.STRING(255), allowNull: true },
      consent_analytics: { type: Sequelize.BOOLEAN, allowNull: true },
      consent_marketing: { type: Sequelize.BOOLEAN, allowNull: true },
      consent_ad_user_data: { type: Sequelize.BOOLEAN, allowNull: true },
      consent_ad_personalization: { type: Sequelize.BOOLEAN, allowNull: true },
      consent_json: { type: Sequelize.JSON, allowNull: true },
      user_agent_hash: { type: Sequelize.STRING(64), allowNull: true },
      ip_hash: { type: Sequelize.STRING(64), allowNull: true },
      screen_width: { type: Sequelize.INTEGER, allowNull: true },
      screen_height: { type: Sequelize.INTEGER, allowNull: true },
      viewport_width: { type: Sequelize.INTEGER, allowNull: true },
      viewport_height: { type: Sequelize.INTEGER, allowNull: true },
      language: { type: Sequelize.STRING(32), allowNull: true },
      metadata: { type: Sequelize.JSON, allowNull: true },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('WebEvents', ['clinic_id', 'occurred_at'], { name: 'idx_web_events_clinic_time' });
    await queryInterface.addIndex('WebEvents', ['group_id', 'occurred_at'], { name: 'idx_web_events_group_time' });
    await queryInterface.addIndex('WebEvents', ['event_name', 'occurred_at'], { name: 'idx_web_events_name_time' });
    await queryInterface.addIndex('WebEvents', ['session_id'], { name: 'idx_web_events_session' });
    await queryInterface.addIndex('WebEvents', ['domain', 'occurred_at'], { name: 'idx_web_events_domain_time' });

    await queryInterface.createTable('WebPageDaily', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      clinic_id: { type: Sequelize.INTEGER, allowNull: true },
      group_id: { type: Sequelize.INTEGER, allowNull: true },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      domain: { type: Sequelize.STRING(255), allowNull: true },
      page_url: { type: Sequelize.STRING(1024), allowNull: true },
      page_path: { type: Sequelize.STRING(512), allowNull: true },
      page_title: { type: Sequelize.STRING(512), allowNull: true },
      pageviews: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      unique_sessions: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      unique_visitors: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      tel_clicks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      whatsapp_clicks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      form_submits: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      leads: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('WebPageDaily', ['clinic_id', 'date'], { name: 'idx_web_page_daily_clinic_date' });
    await queryInterface.addIndex('WebPageDaily', ['group_id', 'date'], { name: 'idx_web_page_daily_group_date' });
    await queryInterface.addIndex('WebPageDaily', ['domain', 'date'], { name: 'idx_web_page_daily_domain_date' });

    await queryInterface.createTable('WebClickDaily', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      clinic_id: { type: Sequelize.INTEGER, allowNull: true },
      group_id: { type: Sequelize.INTEGER, allowNull: true },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      domain: { type: Sequelize.STRING(255), allowNull: true },
      page_url: { type: Sequelize.STRING(1024), allowNull: true },
      click_type: { type: Sequelize.STRING(80), allowNull: false },
      target: { type: Sequelize.STRING(512), allowNull: true },
      clicks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      unique_sessions: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('WebClickDaily', ['clinic_id', 'date'], { name: 'idx_web_click_daily_clinic_date' });
    await queryInterface.addIndex('WebClickDaily', ['group_id', 'date'], { name: 'idx_web_click_daily_group_date' });
    await queryInterface.addIndex('WebClickDaily', ['click_type', 'date'], { name: 'idx_web_click_daily_type_date' });

    await queryInterface.createTable('WebSessionDaily', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      clinic_id: { type: Sequelize.INTEGER, allowNull: true },
      group_id: { type: Sequelize.INTEGER, allowNull: true },
      date: { type: Sequelize.DATEONLY, allowNull: false },
      domain: { type: Sequelize.STRING(255), allowNull: true },
      sessions: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      visitors: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      pageviews: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      tel_clicks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      whatsapp_clicks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      form_submits: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('WebSessionDaily', ['clinic_id', 'date'], { name: 'idx_web_session_daily_clinic_date' });
    await queryInterface.addIndex('WebSessionDaily', ['group_id', 'date'], { name: 'idx_web_session_daily_group_date' });
    await queryInterface.addIndex('WebSessionDaily', ['domain', 'date'], { name: 'idx_web_session_daily_domain_date' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('WebSessionDaily');
    await queryInterface.dropTable('WebClickDaily');
    await queryInterface.dropTable('WebPageDaily');
    await queryInterface.dropTable('WebEvents');
  },
};
