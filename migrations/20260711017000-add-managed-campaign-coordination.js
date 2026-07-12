'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('ManagedCampaigns', 'next_action', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
    await queryInterface.addColumn('ManagedCampaigns', 'operational_blocker', {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.createTable('ManagedCampaignOperationAudits', {
      id: { type: Sequelize.STRING(36), primaryKey: true, allowNull: false },
      managed_campaign_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        references: { model: 'ManagedCampaigns', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      event_type: { type: Sequelize.STRING(64), allowNull: false },
      actor_user_id: { type: Sequelize.INTEGER, allowNull: false },
      from_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      to_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      changes: { type: Sequelize.JSON, allowNull: false },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
    await queryInterface.addIndex(
      'ManagedCampaignOperationAudits',
      ['managed_campaign_id', 'created_at'],
      { name: 'idx_managed_campaign_operation_audit_campaign_date' }
    );
    await queryInterface.addIndex(
      'ManagedCampaignOperationAudits',
      ['actor_user_id', 'created_at'],
      { name: 'idx_managed_campaign_operation_audit_actor_date' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ManagedCampaignOperationAudits');
    await queryInterface.removeColumn('ManagedCampaigns', 'operational_blocker');
    await queryInterface.removeColumn('ManagedCampaigns', 'next_action');
  },
};
