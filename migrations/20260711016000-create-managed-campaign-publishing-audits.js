'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ManagedCampaignPublishingAudits', {
      id: { type: Sequelize.STRING(36), primaryKey: true, allowNull: false },
      managed_campaign_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        references: { model: 'ManagedCampaigns', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      plan_id: { type: Sequelize.STRING(191), allowNull: false },
      plan_hash: { type: Sequelize.STRING(64), allowNull: false },
      campaign_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      provider: { type: Sequelize.STRING(32), allowNull: false },
      family: { type: Sequelize.STRING(64), allowNull: false },
      mode: { type: Sequelize.ENUM('dry_run'), allowNull: false, defaultValue: 'dry_run' },
      readiness_status: { type: Sequelize.ENUM('ready', 'blocked'), allowNull: false },
      blocker_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      warning_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      gate_evidence: { type: Sequelize.JSON, allowNull: false },
      plan_snapshot: { type: Sequelize.JSON, allowNull: false },
      idempotency_key: { type: Sequelize.STRING(191), allowNull: false },
      requested_by_user_id: { type: Sequelize.INTEGER, allowNull: false },
      provider_call_performed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });
    await queryInterface.addConstraint('ManagedCampaignPublishingAudits', {
      fields: ['managed_campaign_id', 'idempotency_key'],
      type: 'unique',
      name: 'uniq_managed_publishing_audit_idempotency',
    });
    await queryInterface.addIndex('ManagedCampaignPublishingAudits', ['managed_campaign_id', 'created_at'], {
      name: 'idx_managed_publishing_audit_campaign_date',
    });
    await queryInterface.addIndex('ManagedCampaignPublishingAudits', ['plan_hash'], {
      name: 'idx_managed_publishing_audit_plan_hash',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ManagedCampaignPublishingAudits');
  },
};
