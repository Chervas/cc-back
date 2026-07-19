'use strict';

function appendOnlyError() {
  const error = new Error('WebPublicationDeployment es append-only salvo transición controlada de estado');
  error.code = 'WEB_PUBLICATION_DEPLOYMENT_IMMUTABLE';
  throw error;
}

const MUTABLE_FIELDS = new Set([
  // A publish deployment is created before its production artifact exists.
  // The worker persists that artifact pointer after the deterministic compile
  // (and may replace it when the trusted runtime changed between retries).
  // It is operational state, not part of the immutable deployment identity.
  'artifactId',
  'status', 'storage', 'result', 'errorCode', 'errorDetails', 'jobRequestId', 'startedAt', 'completedAt',
]);

function rejectImmutableFields(changed) {
  if ((Array.isArray(changed) ? changed : []).some((field) => !MUTABLE_FIELDS.has(field))) appendOnlyError();
}

function rejectImmutableInstance(instance) {
  const reported = typeof instance.changed === 'function' ? instance.changed() : [];
  const changed = Array.isArray(reported) ? reported : [];
  rejectImmutableFields(changed);
  if (changed.includes('artifactId') && String(instance.status || '') !== 'running') appendOnlyError();
}

function rejectImmutableBulk(options = {}) {
  const changed = options.fields || Object.keys(options.attributes || {});
  rejectImmutableFields(changed);
  // Bulk updates cannot prove that every affected deployment owns the running
  // lease, so artifact pointers are only persisted through a locked instance.
  if (changed.includes('artifactId')) appendOnlyError();
}

module.exports = (sequelize, DataTypes) => {
  const WebPublicationDeployment = sequelize.define('WebPublicationDeployment', {
    id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true, validate: { isUUID: 4 } },
    publicationId: { type: DataTypes.STRING(36), allowNull: false, field: 'publication_id' },
    projectId: { type: DataTypes.STRING(36), allowNull: false, field: 'project_id' },
    revisionId: { type: DataTypes.STRING(36), allowNull: true, field: 'revision_id' },
    artifactId: { type: DataTypes.STRING(36), allowNull: true, field: 'artifact_id' },
    previousArtifactId: { type: DataTypes.STRING(36), allowNull: true, field: 'previous_artifact_id' },
    sequence: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    action: { type: DataTypes.ENUM('publish', 'rollback', 'retire', 'healthcheck'), allowNull: false },
    status: {
      type: DataTypes.ENUM('queued', 'running', 'verified', 'failed', 'superseded'),
      allowNull: false,
      defaultValue: 'queued',
    },
    expectedPublicationVersion: {
      type: DataTypes.INTEGER.UNSIGNED, allowNull: false, field: 'expected_publication_version',
    },
    storage: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    result: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    errorCode: { type: DataTypes.STRING(128), allowNull: true, field: 'error_code' },
    errorDetails: { type: DataTypes.JSON, allowNull: true, field: 'error_details' },
    jobRequestId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'job_request_id' },
    requestId: { type: DataTypes.STRING(80), allowNull: true, field: 'request_id' },
    actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
    startedAt: { type: DataTypes.DATE, allowNull: true, field: 'started_at' },
    completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
  }, {
    tableName: 'WebPublicationDeployments',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
      { unique: true, fields: ['publication_id', 'sequence'] },
      { fields: ['publication_id', 'status', 'created_at'] },
      { name: 'idx_web_publication_deployments_artifact_status', fields: ['artifact_id', 'status', 'publication_id'] },
      { fields: ['job_request_id'] },
    ],
    hooks: {
      beforeUpdate: rejectImmutableInstance,
      beforeDestroy: appendOnlyError,
      beforeBulkUpdate: rejectImmutableBulk,
      beforeBulkDestroy: appendOnlyError,
    },
  });
  WebPublicationDeployment.associate = function associate(models) {
    WebPublicationDeployment.belongsTo(models.WebPublication, { foreignKey: 'publicationId', as: 'publication', onDelete: 'RESTRICT' });
    WebPublicationDeployment.belongsTo(models.WebProject, { foreignKey: 'projectId', as: 'project', onDelete: 'RESTRICT' });
    WebPublicationDeployment.belongsTo(models.WebRevision, { foreignKey: 'revisionId', as: 'revision', onDelete: 'RESTRICT' });
    WebPublicationDeployment.belongsTo(models.WebArtifact, { foreignKey: 'artifactId', as: 'artifact', onDelete: 'RESTRICT' });
    WebPublicationDeployment.belongsTo(models.WebArtifact, { foreignKey: 'previousArtifactId', as: 'previousArtifact', onDelete: 'RESTRICT' });
    WebPublicationDeployment.belongsTo(models.JobRequest, { foreignKey: 'jobRequestId', as: 'jobRequest', onDelete: 'SET NULL' });
  };
  return WebPublicationDeployment;
};
