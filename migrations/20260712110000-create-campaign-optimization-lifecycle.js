'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('CampaignOptimizationPolicies', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      scope_type: { type: Sequelize.ENUM('clinic', 'group'), allowNull: false },
      scope_id: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
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
      mode: { type: Sequelize.ENUM('connect_only', 'managed_service'), allowNull: false },
      strategy_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Campaigns', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      managed_campaign_id: {
        type: Sequelize.STRING(36),
        allowNull: true,
        references: { model: 'ManagedCampaigns', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      customer_ids: { type: Sequelize.JSON, allowNull: false },
      campaign_ids: { type: Sequelize.JSON, allowNull: false },
      lifecycle_state: { type: Sequelize.JSON, allowNull: false },
      thresholds: { type: Sequelize.JSON, allowNull: false },
      status: {
        type: Sequelize.ENUM('active', 'paused', 'completed', 'archived'),
        allowNull: false,
        defaultValue: 'paused'
      },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      next_evaluation_at: { type: Sequelize.DATE, allowNull: true },
      last_evaluated_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('CampaignOptimizationPolicies', ['status', 'next_evaluation_at'], {
      name: 'idx_campaign_optimization_policy_due'
    });
    await queryInterface.addIndex('CampaignOptimizationPolicies', ['scope_type', 'scope_id', 'status'], {
      name: 'idx_campaign_optimization_policy_scope'
    });
    await queryInterface.addIndex('CampaignOptimizationPolicies', ['managed_campaign_id'], {
      name: 'idx_campaign_optimization_policy_managed'
    });
    await queryInterface.addIndex('CampaignOptimizationPolicies', ['strategy_id'], {
      name: 'idx_campaign_optimization_policy_strategy'
    });

    await queryInterface.createTable('CampaignOptimizationEvaluations', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      policy_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        references: { model: 'CampaignOptimizationPolicies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      policy_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      evaluation_date: { type: Sequelize.DATEONLY, allowNull: false },
      evaluated_at: { type: Sequelize.DATE, allowNull: false },
      metrics: { type: Sequelize.JSON, allowNull: false },
      evidence: { type: Sequelize.JSON, allowNull: false },
      blockers: { type: Sequelize.JSON, allowNull: false },
      decision_digest: { type: Sequelize.STRING(64), allowNull: false },
      eligible_now: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      ready_for_approval: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      status: {
        type: Sequelize.ENUM('blocked', 'observing', 'ready', 'terminal', 'error'),
        allowNull: false,
        defaultValue: 'blocked'
      },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addConstraint('CampaignOptimizationEvaluations', {
      fields: ['policy_id', 'evaluation_date'],
      type: 'unique',
      name: 'uniq_campaign_optimization_evaluation_day'
    });
    await queryInterface.addIndex('CampaignOptimizationEvaluations', ['policy_id', 'evaluated_at'], {
      name: 'idx_campaign_optimization_evaluation_policy_time'
    });
    await queryInterface.addIndex('CampaignOptimizationEvaluations', ['status', 'evaluated_at'], {
      name: 'idx_campaign_optimization_evaluation_status'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('CampaignOptimizationEvaluations');
    await queryInterface.dropTable('CampaignOptimizationPolicies');
  }
};
