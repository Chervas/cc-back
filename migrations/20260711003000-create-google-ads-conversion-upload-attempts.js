'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('GoogleAdsConversionUploadAttempts', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      dedupe_key: { type: Sequelize.STRING(64), allowNull: false },
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
      intake_config_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'IntakeConfigs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      google_connection_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GoogleConnections', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      google_connection_assignment_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GoogleConnectionAssignments', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      assignment_scope: { type: Sequelize.ENUM('clinic', 'group'), allowNull: false },
      connection_source: { type: Sequelize.STRING(64), allowNull: true },
      customer_id: { type: Sequelize.STRING(32), allowNull: true },
      login_customer_id: { type: Sequelize.STRING(32), allowNull: true },
      conversion_action: { type: Sequelize.STRING(256), allowNull: true },
      event_name: { type: Sequelize.STRING(64), allowNull: false },
      event_id: { type: Sequelize.STRING(191), allowNull: true },
      click_id_type: { type: Sequelize.ENUM('gclid', 'gbraid', 'wbraid'), allowNull: false },
      click_id_hash: { type: Sequelize.STRING(64), allowNull: false },
      consent_status: {
        type: Sequelize.ENUM('GRANTED', 'DENIED', 'UNSPECIFIED'),
        allowNull: false,
        defaultValue: 'UNSPECIFIED'
      },
      status: {
        type: Sequelize.ENUM('pending', 'succeeded', 'failed', 'skipped'),
        allowNull: false,
        defaultValue: 'pending'
      },
      reason: { type: Sequelize.STRING(128), allowNull: true },
      provider_request_id: { type: Sequelize.STRING(191), allowNull: true },
      attempt_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      request_metadata: { type: Sequelize.JSON, allowNull: true },
      response_metadata: { type: Sequelize.JSON, allowNull: true },
      history: { type: Sequelize.JSON, allowNull: true },
      last_error_code: { type: Sequelize.STRING(128), allowNull: true },
      last_error_message: { type: Sequelize.TEXT, allowNull: true },
      attempted_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      completed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addConstraint('GoogleAdsConversionUploadAttempts', {
      fields: ['dedupe_key'],
      type: 'unique',
      name: 'uniq_google_ads_conversion_upload_dedupe'
    });
    await queryInterface.addIndex('GoogleAdsConversionUploadAttempts', ['clinica_id', 'attempted_at'], {
      name: 'idx_google_ads_conversion_upload_clinic'
    });
    await queryInterface.addIndex('GoogleAdsConversionUploadAttempts', ['grupo_clinica_id', 'attempted_at'], {
      name: 'idx_google_ads_conversion_upload_group'
    });
    await queryInterface.addIndex('GoogleAdsConversionUploadAttempts', ['customer_id', 'status', 'attempted_at'], {
      name: 'idx_google_ads_conversion_upload_customer_status'
    });
    await queryInterface.addIndex('GoogleAdsConversionUploadAttempts', ['event_id'], {
      name: 'idx_google_ads_conversion_upload_event'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('GoogleAdsConversionUploadAttempts');
  }
};
