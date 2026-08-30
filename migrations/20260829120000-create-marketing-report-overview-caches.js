'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('MarketingReportOverviewCaches', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true, allowNull: false },
      cache_key: { type: Sequelize.STRING(64), allowNull: false },
      report_version: { type: Sequelize.STRING(96), allowNull: false },
      section: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'overview' },
      scope_key: { type: Sequelize.STRING(64), allowNull: false },
      scope_type: { type: Sequelize.STRING(32), allowNull: true },
      scope_payload: { type: Sequelize.JSON, allowNull: false },
      primary_clinic_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'Clinicas', key: 'id_clinica' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      group_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'GruposClinicas', key: 'id_grupo' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      period_start: { type: Sequelize.DATEONLY, allowNull: false },
      period_end: { type: Sequelize.DATEONLY, allowNull: false },
      comparison_start: { type: Sequelize.DATEONLY, allowNull: false },
      comparison_end: { type: Sequelize.DATEONLY, allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: true },
      generated_at: { type: Sequelize.DATE, allowNull: true },
      data_cutoff_at: { type: Sequelize.DATE, allowNull: true },
      fresh_until: { type: Sequelize.DATE, allowNull: true },
      expires_at: { type: Sequelize.DATE, allowNull: true },
      refresh_state: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'idle' },
      refresh_lock_token: { type: Sequelize.STRING(64), allowNull: true },
      refresh_locked_until: { type: Sequelize.DATE, allowNull: true },
      last_refresh_started_at: { type: Sequelize.DATE, allowNull: true },
      last_refresh_finished_at: { type: Sequelize.DATE, allowNull: true },
      last_refresh_error: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('MarketingReportOverviewCaches', ['cache_key'], {
      unique: true,
      name: 'uniq_marketing_report_overview_cache_key'
    });
    await queryInterface.addIndex('MarketingReportOverviewCaches', ['primary_clinic_id', 'period_end'], {
      name: 'idx_marketing_report_overview_clinic_period'
    });
    await queryInterface.addIndex('MarketingReportOverviewCaches', ['group_id', 'period_end'], {
      name: 'idx_marketing_report_overview_group_period'
    });
    await queryInterface.addIndex('MarketingReportOverviewCaches', ['expires_at'], {
      name: 'idx_marketing_report_overview_expires'
    });
    await queryInterface.addIndex('MarketingReportOverviewCaches', ['refresh_locked_until'], {
      name: 'idx_marketing_report_overview_refresh_lease'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('MarketingReportOverviewCaches');
  }
};
