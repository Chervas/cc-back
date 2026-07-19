'use strict';

const { validateClinicScope } = require('../src/lib/webDocumentModel');

module.exports = (sequelize, DataTypes) => {
  const WebPublication = sequelize.define('WebPublication', {
    id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true, validate: { isUUID: 4 } },
    projectId: { type: DataTypes.STRING(36), allowNull: false, field: 'project_id' },
    scopeType: { type: DataTypes.ENUM('clinic', 'group'), allowNull: false, field: 'scope_type' },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinica_id' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupo_clinica_id' },
    channel: { type: DataTypes.ENUM('clinicaclick_hosted', 'wordpress', 'custom_domain'), allowNull: false },
    domainId: { type: DataTypes.STRING(36), allowNull: true, field: 'domain_id' },
    wordpressInstallationId: { type: DataTypes.STRING(36), allowNull: true, field: 'wordpress_installation_id' },
    host: { type: DataTypes.STRING(253), allowNull: false },
    path: { type: DataTypes.STRING(512), allowNull: false, defaultValue: '/' },
    status: {
      type: DataTypes.ENUM('draft', 'pending', 'publishing', 'published', 'failed', 'rolling_back', 'retired'),
      allowNull: false,
      defaultValue: 'draft',
    },
    desiredRevisionId: { type: DataTypes.STRING(36), allowNull: true, field: 'desired_revision_id' },
    activeRevisionId: { type: DataTypes.STRING(36), allowNull: true, field: 'active_revision_id' },
    activeArtifactId: { type: DataTypes.STRING(36), allowNull: true, field: 'active_artifact_id' },
    lastGoodArtifactId: { type: DataTypes.STRING(36), allowNull: true, field: 'last_good_artifact_id' },
    configuration: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    health: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    lastErrorCode: { type: DataTypes.STRING(128), allowNull: true, field: 'last_error_code' },
    lastErrorMessage: { type: DataTypes.TEXT, allowNull: true, field: 'last_error_message' },
    jobRequestId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'job_request_id' },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    publishedAt: { type: DataTypes.DATE, allowNull: true, field: 'published_at' },
    lastHealthyAt: { type: DataTypes.DATE, allowNull: true, field: 'last_healthy_at' },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by_user_id' },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by_user_id' },
    retiredAt: { type: DataTypes.DATE, allowNull: true, field: 'retired_at' },
  }, {
    tableName: 'WebPublications',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    validate: { coherentScope() { validateClinicScope(this); } },
    indexes: [
      { unique: true, fields: ['host', 'path'] },
      { fields: ['project_id', 'status'] },
      { fields: ['clinica_id', 'status'] },
      { fields: ['grupo_clinica_id', 'status'] },
      { fields: ['job_request_id'] },
      { name: 'idx_web_publications_wordpress_status_path', fields: ['wordpress_installation_id', 'status', 'path'] },
    ],
  });
  WebPublication.associate = function associate(models) {
    WebPublication.belongsTo(models.WebProject, { foreignKey: 'projectId', as: 'project', onDelete: 'RESTRICT' });
    WebPublication.belongsTo(models.WebDomain, { foreignKey: 'domainId', as: 'domain', onDelete: 'RESTRICT' });
    WebPublication.belongsTo(models.WebWordpressInstallation, {
      foreignKey: 'wordpressInstallationId', as: 'wordpressInstallation', onDelete: 'RESTRICT',
    });
    WebPublication.belongsTo(models.WebRevision, { foreignKey: 'desiredRevisionId', as: 'desiredRevision', onDelete: 'RESTRICT' });
    WebPublication.belongsTo(models.WebRevision, { foreignKey: 'activeRevisionId', as: 'activeRevision', onDelete: 'RESTRICT' });
    WebPublication.belongsTo(models.WebArtifact, { foreignKey: 'activeArtifactId', as: 'activeArtifact', onDelete: 'RESTRICT' });
    WebPublication.belongsTo(models.WebArtifact, { foreignKey: 'lastGoodArtifactId', as: 'lastGoodArtifact', onDelete: 'RESTRICT' });
    WebPublication.belongsTo(models.JobRequest, { foreignKey: 'jobRequestId', as: 'jobRequest', onDelete: 'SET NULL' });
    WebPublication.hasMany(models.WebPublicationDeployment, { foreignKey: 'publicationId', as: 'deployments' });
  };
  return WebPublication;
};
