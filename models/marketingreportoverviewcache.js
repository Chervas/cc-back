'use strict';

module.exports = (sequelize, DataTypes) => {
  const MarketingReportOverviewCache = sequelize.define('MarketingReportOverviewCache', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    cache_key: { type: DataTypes.STRING(64), allowNull: false },
    report_version: { type: DataTypes.STRING(96), allowNull: false },
    section: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'overview' },
    scope_key: { type: DataTypes.STRING(64), allowNull: false },
    scope_type: { type: DataTypes.STRING(32), allowNull: true },
    scope_payload: { type: DataTypes.JSON, allowNull: false },
    primary_clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    group_id: { type: DataTypes.INTEGER, allowNull: true },
    period_start: { type: DataTypes.DATEONLY, allowNull: false },
    period_end: { type: DataTypes.DATEONLY, allowNull: false },
    comparison_start: { type: DataTypes.DATEONLY, allowNull: false },
    comparison_end: { type: DataTypes.DATEONLY, allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: true },
    generated_at: { type: DataTypes.DATE, allowNull: true },
    data_cutoff_at: { type: DataTypes.DATE, allowNull: true },
    fresh_until: { type: DataTypes.DATE, allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: true },
    refresh_state: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'idle' },
    refresh_lock_token: { type: DataTypes.STRING(64), allowNull: true },
    refresh_locked_until: { type: DataTypes.DATE, allowNull: true },
    last_refresh_started_at: { type: DataTypes.DATE, allowNull: true },
    last_refresh_finished_at: { type: DataTypes.DATE, allowNull: true },
    last_refresh_error: { type: DataTypes.TEXT, allowNull: true }
  }, {
    tableName: 'MarketingReportOverviewCaches',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['cache_key'], name: 'uniq_marketing_report_overview_cache_key' },
      { fields: ['primary_clinic_id', 'period_end'], name: 'idx_marketing_report_overview_clinic_period' },
      { fields: ['group_id', 'period_end'], name: 'idx_marketing_report_overview_group_period' },
      { fields: ['expires_at'], name: 'idx_marketing_report_overview_expires' },
      { fields: ['refresh_locked_until'], name: 'idx_marketing_report_overview_refresh_lease' }
    ]
  });

  MarketingReportOverviewCache.associate = function(models) {
    MarketingReportOverviewCache.belongsTo(models.Clinica, {
      foreignKey: 'primary_clinic_id',
      targetKey: 'id_clinica',
      as: 'primaryClinic'
    });
    MarketingReportOverviewCache.belongsTo(models.GrupoClinica, {
      foreignKey: 'group_id',
      targetKey: 'id_grupo',
      as: 'group'
    });
  };

  return MarketingReportOverviewCache;
};
