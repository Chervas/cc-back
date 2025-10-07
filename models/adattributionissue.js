'use strict';

module.exports = (sequelize, DataTypes) => {
  const AdAttributionIssue = sequelize.define('AdAttributionIssue', {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    provider: { type: DataTypes.ENUM('meta', 'google'), allowNull: false },
    ad_account_id: { type: DataTypes.STRING(64), allowNull: true },
    customer_id: { type: DataTypes.STRING(64), allowNull: true },
    entity_level: { type: DataTypes.ENUM('campaign', 'adset', 'ad', 'ad_group', 'asset_group'), allowNull: false },
    entity_id: { type: DataTypes.STRING(128), allowNull: false },
    campaign_id: { type: DataTypes.STRING(64), allowNull: true },
    campaign_name: { type: DataTypes.STRING(256), allowNull: true },
    adset_name: { type: DataTypes.STRING(256), allowNull: true },
    detected_tokens: { type: DataTypes.JSON, allowNull: true },
    match_candidates: { type: DataTypes.JSON, allowNull: true },
    grupo_clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.ENUM('open', 'resolved'), allowNull: false, defaultValue: 'open' },
    last_seen_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    resolved_at: { type: DataTypes.DATE, allowNull: true },
    resolution_note: { type: DataTypes.STRING(512), allowNull: true }
  }, {
    tableName: 'AdAttributionIssues',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { unique: true, fields: ['provider', 'entity_level', 'entity_id'], name: 'uniq_ad_issue_provider_entity' },
      { fields: ['status', 'last_seen_at'], name: 'idx_ad_issue_status_last_seen' }
    ]
  });

  AdAttributionIssue.associate = function(models) {
    AdAttributionIssue.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
    AdAttributionIssue.belongsTo(models.GrupoClinica, { foreignKey: 'grupo_clinica_id', targetKey: 'id_grupo', as: 'grupoClinica' });
  };

  return AdAttributionIssue;
};
