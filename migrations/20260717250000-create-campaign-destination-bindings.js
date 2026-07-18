'use strict';

/**
 * Durable bridge between a marketing strategy target and a verified Web
 * publication. Provider operations live in the child table so one account can
 * fail/read back/roll back without lying about the rest of the aggregate.
 *
 * `treatment_identity` is the null-safe projection of `treatment_id`: zero is
 * reserved for the general target. MySQL unique indexes consider NULL values
 * distinct, therefore indexing the nullable FK directly would allow duplicate
 * general bindings.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('CampaignDestinationBindings', {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      strategy_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'Campaigns', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      target_kind: {
        type: Sequelize.ENUM('general', 'treatment'),
        allowNull: false,
      },
      treatment_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Tratamientos', key: 'id_tratamiento' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      treatment_identity: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
        comment: 'Null-safe treatment_id projection; 0 means the general target',
      },
      mode: {
        type: Sequelize.ENUM('connect_only', 'guided_improvement', 'managed_service'),
        allowNull: false,
      },
      scope_type: { type: Sequelize.ENUM('clinic', 'group'), allowNull: false },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      grupo_clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      project_id: {
        type: Sequelize.STRING(36), allowNull: false,
        references: { model: 'WebProjects', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      publication_id: {
        type: Sequelize.STRING(36), allowNull: false,
        references: { model: 'WebPublications', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      revision_id: {
        type: Sequelize.STRING(36), allowNull: false,
        references: { model: 'WebRevisions', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      artifact_id: {
        type: Sequelize.STRING(36), allowNull: false,
        references: { model: 'WebArtifacts', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT',
      },
      destination_url: { type: Sequelize.TEXT, allowNull: false },
      destination_digest: { type: Sequelize.STRING(64), allowNull: false },
      active_destination_url: { type: Sequelize.TEXT, allowNull: true },
      active_destination_digest: { type: Sequelize.STRING(64), allowNull: true },
      landing_event_id: { type: Sequelize.STRING(80), allowNull: false },
      destination_ready_event_id: { type: Sequelize.STRING(80), allowNull: true },
      publication_status: {
        type: Sequelize.ENUM('verified', 'invalid', 'retired'),
        allowNull: false,
        defaultValue: 'verified',
      },
      destination_status: {
        type: Sequelize.ENUM(
          'ready', 'apply_queued', 'applying', 'readback_pending', 'active',
          'rollback_queued', 'rolling_back', 'rolled_back', 'blocked', 'failed', 'drifted'
        ),
        allowNull: false,
        defaultValue: 'ready',
      },
      capability_status: {
        type: Sequelize.ENUM('blocked', 'ready', 'active'),
        allowNull: false,
        defaultValue: 'ready',
      },
      authorization: { type: Sequelize.JSON, allowNull: false },
      last_error_code: { type: Sequelize.STRING(128), allowNull: true },
      last_error_details: { type: Sequelize.JSON, allowNull: true },
      version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
      active_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });

    await queryInterface.addConstraint('CampaignDestinationBindings', {
      fields: ['strategy_id', 'target_kind', 'treatment_identity'],
      type: 'unique',
      name: 'uniq_campaign_destination_binding_target_nullsafe',
    });
    await queryInterface.addConstraint('CampaignDestinationBindings', {
      fields: ['landing_event_id'],
      type: 'unique',
      name: 'uniq_campaign_destination_binding_landing_event',
    });
    await queryInterface.addIndex('CampaignDestinationBindings', ['strategy_id', 'target_kind', 'treatment_id'], {
      name: 'idx_campaign_destination_binding_target',
    });
    await queryInterface.addIndex('CampaignDestinationBindings', ['publication_id', 'publication_status'], {
      name: 'idx_campaign_destination_binding_publication',
    });
    await queryInterface.addIndex('CampaignDestinationBindings', ['destination_status', 'updated_at'], {
      name: 'idx_campaign_destination_binding_status',
    });

    await queryInterface.createTable('CampaignDestinationBindingAccounts', {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      binding_id: {
        type: Sequelize.STRING(36),
        allowNull: false,
        references: { model: 'CampaignDestinationBindings', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      managed_campaign_id: {
        type: Sequelize.STRING(36),
        allowNull: true,
        references: { model: 'ManagedCampaigns', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
      },
      provider: { type: Sequelize.ENUM('google_ads', 'meta_ads'), allowNull: false },
      customer_id: { type: Sequelize.STRING(64), allowNull: false },
      campaign_id: { type: Sequelize.STRING(128), allowNull: false },
      family: {
        type: Sequelize.ENUM('google_search', 'google_pmax', 'meta_instant_form', 'meta_reach', 'unsupported'),
        allowNull: false,
      },
      pmax_url_expansion: {
        type: Sequelize.ENUM('not_applicable', 'pending', 'enabled', 'disabled'),
        allowNull: false,
        defaultValue: 'not_applicable',
      },
      state: {
        type: Sequelize.ENUM(
          'ready', 'apply_queued', 'applying', 'readback_pending', 'active',
          'rollback_queued', 'rolling_back', 'rolled_back', 'blocked', 'failed', 'drifted'
        ),
        allowNull: false,
        defaultValue: 'ready',
      },
      before_state: { type: Sequelize.JSON, allowNull: true },
      desired_state: { type: Sequelize.JSON, allowNull: false },
      observed_state: { type: Sequelize.JSON, allowNull: true },
      operation_digest: { type: Sequelize.STRING(64), allowNull: false },
      apply_event_id: { type: Sequelize.STRING(80), allowNull: true },
      readback_event_id: { type: Sequelize.STRING(80), allowNull: true },
      rollback_event_id: { type: Sequelize.STRING(80), allowNull: true },
      apply_job_request_id: {
        type: Sequelize.INTEGER.UNSIGNED, allowNull: true,
        references: { model: 'JobRequests', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      rollback_job_request_id: {
        type: Sequelize.INTEGER.UNSIGNED, allowNull: true,
        references: { model: 'JobRequests', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      authorization: { type: Sequelize.JSON, allowNull: false },
      last_error_code: { type: Sequelize.STRING(128), allowNull: true },
      last_error_details: { type: Sequelize.JSON, allowNull: true },
      applied_at: { type: Sequelize.DATE, allowNull: true },
      readback_at: { type: Sequelize.DATE, allowNull: true },
      rolled_back_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP') },
    });
    await queryInterface.addConstraint('CampaignDestinationBindingAccounts', {
      fields: ['binding_id', 'provider', 'customer_id', 'campaign_id'],
      type: 'unique',
      name: 'uniq_campaign_destination_binding_account',
    });
    await queryInterface.addConstraint('CampaignDestinationBindingAccounts', {
      fields: ['apply_event_id'],
      type: 'unique',
      name: 'uniq_campaign_destination_binding_apply_event',
    });
    await queryInterface.addConstraint('CampaignDestinationBindingAccounts', {
      fields: ['rollback_event_id'],
      type: 'unique',
      name: 'uniq_campaign_destination_binding_rollback_event',
    });
    await queryInterface.addIndex('CampaignDestinationBindingAccounts', ['provider', 'customer_id', 'state'], {
      name: 'idx_campaign_destination_binding_account_state',
    });
    await queryInterface.addIndex('CampaignDestinationBindingAccounts', ['binding_id', 'state'], {
      name: 'idx_campaign_destination_binding_account_binding_state',
    });

    await queryInterface.createTable('CampaignDestinationBindingEvents', {
      id: { type: Sequelize.STRING(36), allowNull: false, primaryKey: true },
      event_id: { type: Sequelize.STRING(80), allowNull: false },
      binding_id: {
        type: Sequelize.STRING(36), allowNull: false,
        references: { model: 'CampaignDestinationBindings', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'CASCADE',
      },
      account_id: {
        type: Sequelize.STRING(36), allowNull: true,
        references: { model: 'CampaignDestinationBindingAccounts', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      event_type: {
        type: Sequelize.ENUM(
          'landing_published', 'destination_ready', 'apply_requested', 'apply_started',
          'readback_verified', 'readback_failed', 'rollback_requested', 'rollback_started',
          'rollback_verified', 'rollback_failed'
        ),
        allowNull: false,
      },
      event_digest: { type: Sequelize.STRING(64), allowNull: false },
      data: { type: Sequelize.JSON, allowNull: false },
      job_request_id: {
        type: Sequelize.INTEGER.UNSIGNED, allowNull: true,
        references: { model: 'JobRequests', key: 'id' }, onUpdate: 'CASCADE', onDelete: 'SET NULL',
      },
      actor_user_id: { type: Sequelize.INTEGER, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });
    await queryInterface.addConstraint('CampaignDestinationBindingEvents', {
      fields: ['event_id'], type: 'unique', name: 'uniq_campaign_destination_binding_event_id',
    });
    await queryInterface.addIndex('CampaignDestinationBindingEvents', ['binding_id', 'created_at'], {
      name: 'idx_campaign_destination_binding_event_binding',
    });
    await queryInterface.addIndex('CampaignDestinationBindingEvents', ['account_id', 'created_at'], {
      name: 'idx_campaign_destination_binding_event_account',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('CampaignDestinationBindingEvents');
    await queryInterface.dropTable('CampaignDestinationBindingAccounts');
    await queryInterface.dropTable('CampaignDestinationBindings');
  },
};
