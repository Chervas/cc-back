'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('AdminCampaignPlaybooks', {
      id: {
        type: Sequelize.STRING(36),
        primaryKey: true,
        allowNull: false,
      },
      catalog_key: {
        type: Sequelize.STRING(191),
        allowNull: false,
        unique: true,
      },
      display_name: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      objective_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      promotion_kind: {
        type: Sequelize.ENUM('treatment_specific', 'generic_campaign'),
        allowNull: false,
      },
      treatment_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      discipline: {
        type: Sequelize.STRING(64),
        allowNull: true,
      },
      family_key: {
        type: Sequelize.STRING(128),
        allowNull: true,
      },
      status: {
        type: Sequelize.ENUM('draft', 'active', 'archived'),
        allowNull: false,
        defaultValue: 'draft',
      },
      channels_supported: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      channels_default: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      recommended_budget_min: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      recommended_budget_max: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      destination_policy: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      measurement_profile: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      automation_strategy: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      template_bundle_refs: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      review_policy: {
        type: Sequelize.JSON,
        allowNull: false,
      },
      notes_internal: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('AdminCampaignPlaybooks', ['objective_id'], {
      name: 'idx_admin_campaign_playbooks_objective',
    });
    await queryInterface.addIndex('AdminCampaignPlaybooks', ['status'], {
      name: 'idx_admin_campaign_playbooks_status',
    });
    await queryInterface.addIndex('AdminCampaignPlaybooks', ['promotion_kind'], {
      name: 'idx_admin_campaign_playbooks_promotion_kind',
    });
    await queryInterface.addIndex('AdminCampaignPlaybooks', ['treatment_id'], {
      name: 'idx_admin_campaign_playbooks_treatment',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('AdminCampaignPlaybooks');
  },
};
