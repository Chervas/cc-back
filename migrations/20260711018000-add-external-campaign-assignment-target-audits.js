'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('ExternalCampaignAssignments', 'strategy_campaign_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'Campaigns', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    });
    await queryInterface.addColumn('ExternalCampaignAssignments', 'campaign_request_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'CampaignRequests', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    });
    await queryInterface.addColumn('ExternalCampaignAssignments', 'target_kind', {
      type: Sequelize.ENUM('generic', 'treatment'),
      allowNull: true,
    });
    await queryInterface.addColumn('ExternalCampaignAssignments', 'target_treatment_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
      references: { model: 'Tratamientos', key: 'id_tratamiento' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    });
    await queryInterface.addColumn('ExternalCampaignAssignments', 'target_confidence', {
      type: Sequelize.DECIMAL(5, 4),
      allowNull: true,
    });
    await queryInterface.addColumn('ExternalCampaignAssignments', 'target_explanation', {
      type: Sequelize.STRING(1024),
      allowNull: true,
    });
    await queryInterface.addColumn('ExternalCampaignAssignments', 'target_updated_by_user_id', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('ExternalCampaignAssignments', 'target_updated_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('ExternalCampaignAssignments', 'version', {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 1,
    });

    await queryInterface.addIndex(
      'ExternalCampaignAssignments',
      ['strategy_campaign_id', 'campaign_request_id', 'status'],
      { name: 'idx_external_campaign_assignment_strategy_target' }
    );

    await queryInterface.createTable('ExternalCampaignAssignmentAudits', {
      id: { type: Sequelize.BIGINT, primaryKey: true, autoIncrement: true },
      assignment_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'ExternalCampaignAssignments', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      },
      event_type: { type: Sequelize.STRING(64), allowNull: false },
      actor_type: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'user' },
      actor_user_id: { type: Sequelize.INTEGER, allowNull: true },
      from_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      to_version: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      reason: { type: Sequelize.STRING(1024), allowNull: true },
      changes: { type: Sequelize.JSON, allowNull: false },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });
    await queryInterface.addIndex(
      'ExternalCampaignAssignmentAudits',
      ['assignment_id', 'created_at'],
      { name: 'idx_external_campaign_assignment_audit_assignment_date' }
    );
    await queryInterface.addIndex(
      'ExternalCampaignAssignmentAudits',
      ['actor_user_id', 'created_at'],
      { name: 'idx_external_campaign_assignment_audit_actor_date' }
    );

    // Existing reviewed decisions need a truthful starting point. When the
    // historical row has no user id, the audit records an explicit system
    // actor instead of inventing a person. Target columns intentionally remain
    // null: target review is a separate human decision.
    await queryInterface.sequelize.query(`
      INSERT INTO ExternalCampaignAssignmentAudits
        (assignment_id, event_type, actor_type, actor_user_id, from_version, to_version, reason, changes, created_at)
      SELECT
        assignment.id,
        CASE
          WHEN assignment.status = 'archived' THEN 'archived_backfill'
          ELSE 'clinic_assigned_backfill'
        END,
        CASE
          WHEN COALESCE(assignment.archived_by_user_id, assignment.approved_by_user_id) IS NULL THEN 'system'
          ELSE 'user'
        END,
        COALESCE(assignment.archived_by_user_id, assignment.approved_by_user_id),
        0,
        assignment.version,
        assignment.archive_reason,
        JSON_OBJECT(
          'status', JSON_OBJECT('before', NULL, 'after', assignment.status),
          'clinica_id', JSON_OBJECT('before', NULL, 'after', assignment.clinica_id),
          'grupo_clinica_id', JSON_OBJECT('before', NULL, 'after', assignment.grupo_clinica_id),
          'match_kind', JSON_OBJECT('before', NULL, 'after', assignment.match_kind),
          'match_confidence', JSON_OBJECT('before', NULL, 'after', assignment.match_confidence)
        ),
        COALESCE(assignment.archived_at, assignment.approved_at, assignment.created_at)
      FROM ExternalCampaignAssignments AS assignment
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('ExternalCampaignAssignmentAudits');
    await queryInterface.removeIndex(
      'ExternalCampaignAssignments',
      'idx_external_campaign_assignment_strategy_target'
    );
    await queryInterface.removeColumn('ExternalCampaignAssignments', 'version');
    await queryInterface.removeColumn('ExternalCampaignAssignments', 'target_updated_at');
    await queryInterface.removeColumn('ExternalCampaignAssignments', 'target_updated_by_user_id');
    await queryInterface.removeColumn('ExternalCampaignAssignments', 'target_explanation');
    await queryInterface.removeColumn('ExternalCampaignAssignments', 'target_confidence');
    await queryInterface.removeColumn('ExternalCampaignAssignments', 'target_treatment_id');
    await queryInterface.removeColumn('ExternalCampaignAssignments', 'target_kind');
    await queryInterface.removeColumn('ExternalCampaignAssignments', 'campaign_request_id');
    await queryInterface.removeColumn('ExternalCampaignAssignments', 'strategy_campaign_id');
  },
};
