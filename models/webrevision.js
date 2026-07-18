'use strict';

const { attachWebDocumentIntegrityHook } = require('../src/lib/webDocumentModel');
const { assertWebContentSnapshot } = require('../src/lib/webContent');

const IMMUTABLE_FIELDS = new Set([
  'projectId',
  'revisionNumber',
  'schemaVersion',
  'document',
  'documentHash',
  'contentSnapshot',
  'createdByUserId',
  'created_at',
]);

function rejectImmutableRevisionChanges(instance, options = {}) {
  const changed = typeof instance.changed === 'function' ? instance.changed() : [];
  let fields = Array.isArray(changed) ? changed : [];
  if (fields.includes('contentSnapshot') && options.webContentSnapshotFreeze === true) {
    const previous = instance.previous('contentSnapshot');
    const previousEmpty = previous && typeof previous === 'object' && !Array.isArray(previous)
      && Object.keys(previous).length === 0;
    if (
      previousEmpty
      && instance.previous('status') === 'review'
      && instance.status === 'approved'
    ) {
      assertWebContentSnapshot(instance.contentSnapshot);
      fields = fields.filter((field) => field !== 'contentSnapshot');
    }
  }
  if (fields.some((field) => IMMUTABLE_FIELDS.has(field))) {
    const error = new Error('El contenido de WebRevision es inmutable');
    error.code = 'WEB_REVISION_IMMUTABLE';
    throw error;
  }
}

function rejectImmutableBulkRevisionChanges(options = {}) {
  const fields = options.fields || Object.keys(options.attributes || {});
  if (fields.some((field) => IMMUTABLE_FIELDS.has(field))) {
    const error = new Error('El contenido de WebRevision es inmutable');
    error.code = 'WEB_REVISION_IMMUTABLE';
    throw error;
  }
}

module.exports = (sequelize, DataTypes) => {
  const WebRevision = sequelize.define('WebRevision', {
    id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      primaryKey: true,
      validate: { isUUID: 4 },
    },
    projectId: { type: DataTypes.STRING(36), allowNull: false, field: 'project_id' },
    revisionNumber: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      field: 'revision_number',
      validate: { min: 1 },
    },
    schemaVersion: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 1,
      field: 'schema_version',
      validate: { isIn: [[1]] },
    },
    document: { type: DataTypes.JSON, allowNull: false },
    documentHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: 'document_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    contentSnapshot: { type: DataTypes.JSON, allowNull: false, defaultValue: {}, field: 'content_snapshot' },
    status: {
      type: DataTypes.ENUM('draft', 'review', 'approved', 'superseded', 'retired', 'failed'),
      allowNull: false,
      defaultValue: 'draft',
    },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by_user_id' },
    submittedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'submitted_by_user_id' },
    submittedAt: { type: DataTypes.DATE, allowNull: true, field: 'submitted_at' },
    approvedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'approved_by_user_id' },
    approvedAt: { type: DataTypes.DATE, allowNull: true, field: 'approved_at' },
  }, {
    tableName: 'WebRevisions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    indexes: [
      { unique: true, fields: ['project_id', 'revision_number'] },
      { fields: ['project_id', 'status', 'created_at'] },
      { fields: ['document_hash'] },
    ],
    hooks: {
      beforeUpdate: rejectImmutableRevisionChanges,
      beforeBulkUpdate: rejectImmutableBulkRevisionChanges,
    },
  });

  attachWebDocumentIntegrityHook(WebRevision);

  WebRevision.associate = function associate(models) {
    WebRevision.belongsTo(models.WebProject, {
      foreignKey: 'projectId',
      as: 'project',
      onDelete: 'RESTRICT',
    });
    WebRevision.belongsTo(models.Usuario, {
      foreignKey: 'createdByUserId',
      targetKey: 'id_usuario',
      as: 'createdBy',
    });
    WebRevision.belongsTo(models.Usuario, {
      foreignKey: 'submittedByUserId',
      targetKey: 'id_usuario',
      as: 'submittedBy',
    });
    WebRevision.belongsTo(models.Usuario, {
      foreignKey: 'approvedByUserId',
      targetKey: 'id_usuario',
      as: 'approvedBy',
    });
    WebRevision.hasMany(models.WebDraft, { foreignKey: 'baseRevisionId', as: 'derivedDrafts' });
    if (models.WebArtifact) {
      WebRevision.hasMany(models.WebArtifact, { foreignKey: 'revisionId', as: 'artifacts' });
    }
  };

  return WebRevision;
};
