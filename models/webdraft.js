'use strict';

const { attachWebDocumentIntegrityHook } = require('../src/lib/webDocumentModel');

module.exports = (sequelize, DataTypes) => {
  const WebDraft = sequelize.define('WebDraft', {
    id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      primaryKey: true,
      validate: { isUUID: 4 },
    },
    projectId: { type: DataTypes.STRING(36), allowNull: false, field: 'project_id', unique: true },
    baseRevisionId: { type: DataTypes.STRING(36), allowNull: true, field: 'base_revision_id' },
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
    lockVersion: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 1,
      field: 'lock_version',
      validate: { min: 1 },
    },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by_user_id' },
  }, {
    tableName: 'WebDrafts',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    version: 'lockVersion',
    indexes: [
      { unique: true, fields: ['project_id'] },
      { fields: ['base_revision_id'] },
    ],
  });

  attachWebDocumentIntegrityHook(WebDraft);

  WebDraft.associate = function associate(models) {
    WebDraft.belongsTo(models.WebProject, {
      foreignKey: 'projectId',
      as: 'project',
      onDelete: 'CASCADE',
    });
    WebDraft.belongsTo(models.WebRevision, {
      foreignKey: 'baseRevisionId',
      as: 'baseRevision',
      onDelete: 'SET NULL',
    });
    WebDraft.belongsTo(models.Usuario, {
      foreignKey: 'updatedByUserId',
      targetKey: 'id_usuario',
      as: 'updatedBy',
    });
  };

  return WebDraft;
};
