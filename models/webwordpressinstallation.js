'use strict';

const { validateClinicScope } = require('../src/lib/webDocumentModel');

module.exports = (sequelize, DataTypes) => {
  const WebWordpressInstallation = sequelize.define('WebWordpressInstallation', {
    id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true, validate: { isUUID: 4 } },
    scopeType: { type: DataTypes.ENUM('clinic', 'group'), allowNull: false, field: 'scope_type' },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinica_id' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupo_clinica_id' },
    siteUrl: { type: DataTypes.STRING(2048), allowNull: false, field: 'site_url' },
    siteUrlHash: { type: DataTypes.STRING(64), allowNull: false, field: 'site_url_hash' },
    claimedSiteHash: { type: DataTypes.STRING(64), allowNull: true, field: 'claimed_site_hash' },
    siteClaimTokenHash: { type: DataTypes.STRING(64), allowNull: true, field: 'site_claim_token_hash' },
    siteClaimIssuedAt: { type: DataTypes.DATE, allowNull: true, field: 'site_claim_issued_at' },
    siteClaimExpiresAt: { type: DataTypes.DATE, allowNull: true, field: 'site_claim_expires_at' },
    siteClaimedAt: { type: DataTypes.DATE, allowNull: true, field: 'site_claimed_at' },
    tokenHash: { type: DataTypes.STRING(64), allowNull: false, field: 'token_hash' },
    tokenPrefix: { type: DataTypes.STRING(16), allowNull: false, field: 'token_prefix' },
    nextTokenHash: { type: DataTypes.STRING(64), allowNull: true, field: 'next_token_hash' },
    nextTokenPrefix: { type: DataTypes.STRING(16), allowNull: true, field: 'next_token_prefix' },
    nextTokenIssuedAt: { type: DataTypes.DATE, allowNull: true, field: 'next_token_issued_at' },
    nextTokenExpiresAt: { type: DataTypes.DATE, allowNull: true, field: 'next_token_expires_at' },
    status: { type: DataTypes.ENUM('pending', 'connected', 'outdated', 'revoked'), allowNull: false, defaultValue: 'pending' },
    pluginVersion: { type: DataTypes.STRING(32), allowNull: true, field: 'plugin_version' },
    capabilities: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    reportedState: { type: DataTypes.JSON, allowNull: false, defaultValue: {}, field: 'reported_state' },
    publicKeyId: { type: DataTypes.STRING(64), allowNull: false, field: 'public_key_id' },
    lastSeenAt: { type: DataTypes.DATE, allowNull: true, field: 'last_seen_at' },
    lastArtifactHash: { type: DataTypes.STRING(64), allowNull: true, field: 'last_artifact_hash' },
    desiredSequence: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0, field: 'desired_sequence' },
    desiredStateHash: {
      type: DataTypes.STRING(64), allowNull: true, field: 'desired_state_hash', validate: { is: /^[a-f0-9]{64}$/ },
    },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by_user_id' },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by_user_id' },
    revokedAt: { type: DataTypes.DATE, allowNull: true, field: 'revoked_at' },
  }, {
    tableName: 'WebWordpressInstallations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    validate: { coherentScope() { validateClinicScope(this); } },
    indexes: [
      { name: 'idx_web_wordpress_site_url_hash', fields: ['site_url_hash'] },
      { name: 'uniq_web_wordpress_claimed_site_hash', unique: true, fields: ['claimed_site_hash'] },
      { unique: true, fields: ['token_hash'] },
      { name: 'uniq_web_wordpress_next_token_hash', unique: true, fields: ['next_token_hash'] },
      { fields: ['clinica_id', 'status'] },
      { fields: ['grupo_clinica_id', 'status'] },
    ],
  });
  WebWordpressInstallation.associate = function associate(models) {
    WebWordpressInstallation.belongsTo(models.Clinica, { foreignKey: 'clinicaId', targetKey: 'id_clinica', as: 'clinica' });
    WebWordpressInstallation.belongsTo(models.GrupoClinica, { foreignKey: 'grupoClinicaId', targetKey: 'id_grupo', as: 'grupoClinica' });
    WebWordpressInstallation.hasMany(models.WebPublication, {
      foreignKey: 'wordpressInstallationId', as: 'publications',
    });
  };
  return WebWordpressInstallation;
};
