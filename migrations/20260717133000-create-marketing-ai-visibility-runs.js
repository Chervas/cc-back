'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('MarketingAiVisibilityRuns', {
      id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      clinica_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      requested_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      query: {
        type: Sequelize.STRING(500),
        allowNull: false,
      },
      query_hash: {
        type: Sequelize.STRING(64),
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'queued',
      },
      provider_status: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      provider_results: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      error_summary: {
        type: Sequelize.JSON,
        allowNull: true,
      },
      job_request_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
      },
      started_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      expires_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
      },
    });

    await queryInterface.addIndex('MarketingAiVisibilityRuns', ['clinica_id', 'created_at'], {
      name: 'idx_marketing_ai_visibility_clinic_created',
    });
    await queryInterface.addIndex('MarketingAiVisibilityRuns', ['clinica_id', 'query_hash', 'created_at'], {
      name: 'idx_marketing_ai_visibility_query_cache',
    });
    await queryInterface.addIndex('MarketingAiVisibilityRuns', ['status'], {
      name: 'idx_marketing_ai_visibility_status',
    });
    await queryInterface.addIndex('MarketingAiVisibilityRuns', ['expires_at'], {
      name: 'idx_marketing_ai_visibility_expires',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('MarketingAiVisibilityRuns');
  },
};
