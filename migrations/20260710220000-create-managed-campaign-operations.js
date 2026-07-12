'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('ExternalCampaignInventories', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      provider: { type: Sequelize.ENUM('google_ads', 'meta_ads'), allowNull: false },
      customer_id: { type: Sequelize.STRING(64), allowNull: false },
      account_name: { type: Sequelize.STRING(255), allowNull: true },
      campaign_id: { type: Sequelize.STRING(128), allowNull: false },
      campaign_name: { type: Sequelize.STRING(512), allowNull: true },
      status: { type: Sequelize.STRING(64), allowNull: true },
      channel_type: { type: Sequelize.STRING(64), allowNull: true },
      source: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'provider_sync' },
      latest_metrics: { type: Sequelize.JSON, allowNull: true },
      destination_detection: { type: Sequelize.JSON, allowNull: true },
      last_seen_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });
    await queryInterface.addConstraint('ExternalCampaignInventories', {
      fields: ['provider', 'customer_id', 'campaign_id'],
      type: 'unique',
      name: 'uniq_external_campaign_inventory',
    });
    await queryInterface.addIndex('ExternalCampaignInventories', ['customer_id', 'status'], { name: 'idx_external_campaign_inventory_customer' });

    await queryInterface.createTable('ExternalCampaignAssignments', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      inventory_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'ExternalCampaignInventories', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      provider: { type: Sequelize.ENUM('google_ads', 'meta_ads'), allowNull: false },
      customer_id: { type: Sequelize.STRING(64), allowNull: false },
      campaign_id: { type: Sequelize.STRING(128), allowNull: false },
      campaign_name_snapshot: { type: Sequelize.STRING(512), allowNull: true },
      grupo_clinica_id: { type: Sequelize.INTEGER, allowNull: true },
      clinica_id: { type: Sequelize.INTEGER, allowNull: false },
      match_kind: { type: Sequelize.ENUM('exact', 'alias', 'fuzzy', 'manual'), allowNull: false, defaultValue: 'manual' },
      match_confidence: { type: Sequelize.DECIMAL(5, 4), allowNull: true },
      match_explanation: { type: Sequelize.STRING(512), allowNull: true },
      status: { type: Sequelize.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
      approved_by_user_id: { type: Sequelize.INTEGER, allowNull: true },
      approved_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });
    await queryInterface.addConstraint('ExternalCampaignAssignments', {
      fields: ['provider', 'customer_id', 'campaign_id'],
      type: 'unique',
      name: 'uniq_external_campaign_assignment',
    });
    await queryInterface.addIndex('ExternalCampaignAssignments', ['grupo_clinica_id', 'clinica_id', 'status'], { name: 'idx_external_campaign_assignment_scope' });

    await queryInterface.createTable('ManagedCampaigns', {
      id: { type: Sequelize.STRING(36), primaryKey: true, allowNull: false },
      strategy_campaign_id: { type: Sequelize.INTEGER, allowNull: true },
      campaign_request_id: { type: Sequelize.INTEGER, allowNull: true },
      objective_id: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'new_patients' },
      clinica_id: { type: Sequelize.INTEGER, allowNull: false },
      grupo_clinica_id: { type: Sequelize.INTEGER, allowNull: true },
      management_mode: { type: Sequelize.ENUM('connect_only', 'autopilot'), allowNull: false, defaultValue: 'autopilot' },
      legacy_mode: { type: Sequelize.STRING(32), allowNull: true },
      operation_mode: { type: Sequelize.ENUM('observe', 'managed'), allowNull: false, defaultValue: 'observe' },
      provider: { type: Sequelize.ENUM('google_ads', 'meta_ads'), allowNull: false },
      family: { type: Sequelize.ENUM('google_search', 'google_pmax', 'google_smart_observe', 'meta_reach', 'meta_instant_form'), allowNull: false },
      status: {
        type: Sequelize.ENUM('draft', 'pending_client_review', 'pending_admin_review', 'changes_requested', 'approved_to_launch', 'launching', 'active', 'paused', 'blocked', 'completed', 'cancelled'),
        allowNull: false,
        defaultValue: 'draft',
      },
      name: { type: Sequelize.STRING(255), allowNull: false },
      target_config: { type: Sequelize.JSON, allowNull: false },
      budget_config: { type: Sequelize.JSON, allowNull: false },
      schedule_config: { type: Sequelize.JSON, allowNull: false },
      destination_config: { type: Sequelize.JSON, allowNull: false },
      audience_config: { type: Sequelize.JSON, allowNull: false },
      creative_config: { type: Sequelize.JSON, allowNull: false },
      tracking_plan: { type: Sequelize.JSON, allowNull: false },
      platform_refs: { type: Sequelize.JSON, allowNull: false },
      review_config: { type: Sequelize.JSON, allowNull: false },
      policy_readiness: { type: Sequelize.JSON, allowNull: false },
      assigned_to_user_id: { type: Sequelize.INTEGER, allowNull: true },
      approved_by_user_id: { type: Sequelize.INTEGER, allowNull: true },
      approved_at: { type: Sequelize.DATE, allowNull: true },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_by_user_id: { type: Sequelize.INTEGER, allowNull: true },
      updated_by_user_id: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('ManagedCampaigns', ['clinica_id', 'status'], { name: 'idx_managed_campaigns_clinic_status' });
    await queryInterface.addIndex('ManagedCampaigns', ['grupo_clinica_id', 'status'], { name: 'idx_managed_campaigns_group_status' });
    await queryInterface.addIndex('ManagedCampaigns', ['assigned_to_user_id', 'status'], { name: 'idx_managed_campaigns_assignee' });

    await queryInterface.createTable('ManagedCampaignFundingAccounts', {
      id: { type: Sequelize.STRING(36), primaryKey: true, allowNull: false },
      managed_campaign_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        unique: true,
        references: { model: 'ManagedCampaigns', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      clinica_id: { type: Sequelize.INTEGER, allowNull: false },
      grupo_clinica_id: { type: Sequelize.INTEGER, allowNull: true },
      currency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'EUR' },
      status: { type: Sequelize.ENUM('unfunded', 'funded', 'low_balance', 'depleted', 'closed'), allowNull: false, defaultValue: 'unfunded' },
      client_gross_funded: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      commission_type: { type: Sequelize.ENUM('percentage', 'fixed'), allowNull: false, defaultValue: 'percentage' },
      commission_value: { type: Sequelize.DECIMAL(10, 4), allowNull: false, defaultValue: 0 },
      commission_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      media_budget_net: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      media_spend: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      reserved_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      available_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      terms_version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('ManagedCampaignFundingAccounts', ['clinica_id', 'status'], { name: 'idx_managed_funding_clinic_status' });

    await queryInterface.createTable('ManagedCampaignLedgerEntries', {
      id: { type: Sequelize.STRING(36), primaryKey: true, allowNull: false },
      funding_account_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        references: { model: 'ManagedCampaignFundingAccounts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      entry_type: { type: Sequelize.ENUM('topup', 'commission', 'media_reserve', 'media_spend', 'release', 'refund', 'adjustment', 'bank_charge'), allowNull: false },
      direction: { type: Sequelize.ENUM('credit', 'debit'), allowNull: false },
      amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'EUR' },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      external_ref: { type: Sequelize.STRING(191), allowNull: true },
      metadata: { type: Sequelize.JSON, allowNull: true },
      created_by_user_id: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('ManagedCampaignLedgerEntries', ['funding_account_id', 'occurred_at'], { name: 'idx_managed_ledger_account_date' });
    await queryInterface.addIndex('ManagedCampaignLedgerEntries', ['external_ref'], { name: 'idx_managed_ledger_external_ref' });

    await queryInterface.createTable('ManagedCampaignSpendSnapshots', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      managed_campaign_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        references: { model: 'ManagedCampaigns', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      provider: { type: Sequelize.ENUM('google_ads', 'meta_ads'), allowNull: false },
      customer_id: { type: Sequelize.STRING(64), allowNull: false },
      platform_campaign_id: { type: Sequelize.STRING(128), allowNull: false },
      spend_date: { type: Sequelize.DATEONLY, allowNull: false },
      spend_amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'EUR' },
      source: { type: Sequelize.STRING(64), allowNull: false, defaultValue: 'provider_sync' },
      captured_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });
    await queryInterface.addConstraint('ManagedCampaignSpendSnapshots', {
      fields: ['managed_campaign_id', 'provider', 'customer_id', 'platform_campaign_id', 'spend_date'],
      type: 'unique',
      name: 'uniq_managed_campaign_spend_day',
    });

    await queryInterface.createTable('ManagedCampaignBankTransactions', {
      id: { type: Sequelize.STRING(36), primaryKey: true, allowNull: false },
      bank_provider: { type: Sequelize.STRING(64), allowNull: false },
      bank_account_ref: { type: Sequelize.STRING(191), allowNull: true },
      booked_at: { type: Sequelize.DATE, allowNull: false },
      value_date: { type: Sequelize.DATEONLY, allowNull: true },
      amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
      currency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'EUR' },
      description: { type: Sequelize.STRING(1024), allowNull: true },
      bank_reference: { type: Sequelize.STRING(191), allowNull: false },
      status: { type: Sequelize.ENUM('unmatched', 'partially_matched', 'matched', 'ignored'), allowNull: false, defaultValue: 'unmatched' },
      metadata: { type: Sequelize.JSON, allowNull: true },
      created_by_user_id: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });
    await queryInterface.addConstraint('ManagedCampaignBankTransactions', {
      fields: ['bank_provider', 'bank_reference'],
      type: 'unique',
      name: 'uniq_managed_bank_transaction',
    });
    await queryInterface.addIndex('ManagedCampaignBankTransactions', ['status', 'booked_at'], { name: 'idx_managed_bank_status_date' });

    await queryInterface.createTable('ManagedCampaignReconciliationMatches', {
      id: { type: Sequelize.STRING(36), primaryKey: true, allowNull: false },
      bank_transaction_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        references: { model: 'ManagedCampaignBankTransactions', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      funding_account_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        references: { model: 'ManagedCampaignFundingAccounts', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      ledger_entry_id: {
        type: Sequelize.STRING(36),
        allowNull: true,
        references: { model: 'ManagedCampaignLedgerEntries', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      },
      amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
      confidence: { type: Sequelize.DECIMAL(5, 4), allowNull: true },
      method: { type: Sequelize.ENUM('automatic', 'manual'), allowNull: false, defaultValue: 'manual' },
      status: { type: Sequelize.ENUM('proposed', 'confirmed', 'rejected'), allowNull: false, defaultValue: 'proposed' },
      notes: { type: Sequelize.STRING(1024), allowNull: true },
      created_by_user_id: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });
    await queryInterface.addIndex('ManagedCampaignReconciliationMatches', ['bank_transaction_id', 'status'], { name: 'idx_managed_reconcile_bank_status' });
    await queryInterface.addIndex('ManagedCampaignReconciliationMatches', ['funding_account_id', 'status'], { name: 'idx_managed_reconcile_funding_status' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ManagedCampaignReconciliationMatches');
    await queryInterface.dropTable('ManagedCampaignBankTransactions');
    await queryInterface.dropTable('ManagedCampaignSpendSnapshots');
    await queryInterface.dropTable('ManagedCampaignLedgerEntries');
    await queryInterface.dropTable('ManagedCampaignFundingAccounts');
    await queryInterface.dropTable('ManagedCampaigns');
    await queryInterface.dropTable('ExternalCampaignAssignments');
    await queryInterface.dropTable('ExternalCampaignInventories');
  },
};
