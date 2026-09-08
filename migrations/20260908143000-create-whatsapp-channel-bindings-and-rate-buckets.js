'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('WhatsappChannelBindings', {
      id: { type: Sequelize.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onDelete: 'CASCADE',
      },
      asset_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'ClinicMetaAssets', key: 'id' },
        onDelete: 'CASCADE',
      },
      role: { type: Sequelize.STRING(16), allowNull: false },
      purposes: { type: Sequelize.JSON, allowNull: false },
      unavailable_action: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'pause' },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      created_by: { type: Sequelize.INTEGER, allowNull: true },
      updated_by: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('WhatsappChannelBindings', ['clinic_id', 'role'], {
      name: 'whatsapp_channel_bindings_clinic_role_unique',
      unique: true,
    });
    await queryInterface.addIndex('WhatsappChannelBindings', ['clinic_id', 'asset_id'], {
      name: 'whatsapp_channel_bindings_clinic_asset_unique',
      unique: true,
    });
    await queryInterface.addIndex('WhatsappChannelBindings', ['asset_id'], {
      name: 'whatsapp_channel_bindings_asset',
    });

    await queryInterface.createTable('AutomationRateLimitBuckets', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      bucket_key: { type: Sequelize.STRING(255), allowNull: false },
      next_available_at: { type: Sequelize.DATE, allowNull: true },
      last_reserved_at: { type: Sequelize.DATE, allowNull: true },
      last_execution_id: { type: Sequelize.INTEGER, allowNull: true },
      metadata: { type: Sequelize.JSON, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('AutomationRateLimitBuckets', ['bucket_key'], {
      name: 'automation_rate_limit_buckets_key_unique',
      unique: true,
    });
    await queryInterface.addIndex('AutomationRateLimitBuckets', ['next_available_at'], {
      name: 'automation_rate_limit_buckets_next',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('AutomationRateLimitBuckets');
    await queryInterface.dropTable('WhatsappChannelBindings');
  },
};
