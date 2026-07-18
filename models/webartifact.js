'use strict';

const MUTABLE_FIELDS = new Set(['status']);

function rejectImmutableFields(fields) {
  if ((Array.isArray(fields) ? fields : []).some((field) => !MUTABLE_FIELDS.has(field))) {
    const error = new Error('El contenido de WebArtifact es inmutable');
    error.code = 'WEB_ARTIFACT_IMMUTABLE';
    throw error;
  }
}

function rejectImmutableInstance(instance) {
  const changed = typeof instance.changed === 'function'
    ? instance.changed()
    : [];
  rejectImmutableFields(changed);
}

function rejectImmutableBulk(options = {}) {
  rejectImmutableFields(options.fields || Object.keys(options.attributes || {}));
}

module.exports = (sequelize, DataTypes) => {
  const WebArtifact = sequelize.define('WebArtifact', {
    id: { type: DataTypes.STRING(36), allowNull: false, primaryKey: true, validate: { isUUID: 4 } },
    projectId: { type: DataTypes.STRING(36), allowNull: false, field: 'project_id' },
    revisionId: { type: DataTypes.STRING(36), allowNull: false, field: 'revision_id' },
    rendererVersion: { type: DataTypes.STRING(64), allowNull: false, field: 'renderer_version' },
    environment: {
      type: DataTypes.ENUM('preview', 'production'),
      allowNull: false,
      defaultValue: 'preview',
    },
    baseUrl: { type: DataTypes.TEXT, allowNull: false, field: 'base_url' },
    baseUrlHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: 'base_url_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    runtimeConfigHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: 'runtime_config_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    artifactHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: 'artifact_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    documentHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: 'document_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    contentSnapshotHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: 'content_snapshot_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    manifest: { type: DataTypes.JSON, allowNull: false },
    files: { type: DataTypes.JSON, allowNull: false },
    qaReport: { type: DataTypes.JSON, allowNull: false, field: 'qa_report' },
    status: {
      type: DataTypes.ENUM('ready', 'failed', 'retired'),
      allowNull: false,
      defaultValue: 'ready',
    },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by_user_id' },
  }, {
    tableName: 'WebArtifacts',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
      { unique: true, fields: ['artifact_hash'] },
      { unique: true, fields: ['revision_id', 'renderer_version', 'environment', 'base_url_hash', 'runtime_config_hash'] },
      { fields: ['project_id', 'created_at'] },
      { fields: ['status', 'created_at'] },
    ],
    hooks: {
      beforeUpdate: rejectImmutableInstance,
      beforeBulkUpdate: rejectImmutableBulk,
    },
  });

  WebArtifact.associate = function associate(models) {
    WebArtifact.belongsTo(models.WebProject, { foreignKey: 'projectId', as: 'project', onDelete: 'RESTRICT' });
    WebArtifact.belongsTo(models.WebRevision, { foreignKey: 'revisionId', as: 'revision', onDelete: 'RESTRICT' });
    WebArtifact.belongsTo(models.Usuario, {
      foreignKey: 'createdByUserId',
      targetKey: 'id_usuario',
      as: 'createdBy',
    });
    if (models.WebPublicationDeployment) {
      WebArtifact.hasMany(models.WebPublicationDeployment, { foreignKey: 'artifactId', as: 'deployments' });
    }
  };

  return WebArtifact;
};
