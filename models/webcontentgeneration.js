'use strict';

const { validateClinicScope } = require('../src/lib/webDocumentModel');

module.exports = (sequelize, DataTypes) => {
  const WebContentGeneration = sequelize.define('WebContentGeneration', {
    id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      primaryKey: true,
      validate: { isUUID: 4 },
    },
    scopeType: {
      type: DataTypes.ENUM('clinic', 'group'),
      allowNull: false,
      field: 'scope_type',
    },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinica_id' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupo_clinica_id' },
    requestedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'requested_by_user_id' },
    contentType: {
      type: DataTypes.ENUM(
        'value_proposition',
        'benefit',
        'faq',
        'treatment_copy',
        'professional_bio',
        'testimonial',
        'legal_copy',
        'article',
        'category'
      ),
      allowNull: false,
      field: 'content_type',
    },
    locale: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'es-ES',
      validate: { is: /^[a-z]{2,3}(?:-[A-Z]{2})?$/ },
    },
    tone: {
      type: DataTypes.ENUM('professional_clear', 'close_reassuring', 'concise', 'informative'),
      allowNull: false,
    },
    objective: { type: DataTypes.STRING(64), allowNull: false },
    contextSnapshot: { type: DataTypes.JSON, allowNull: false, field: 'context_snapshot' },
    inputHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: 'input_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    idempotencyKeyHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: 'idempotency_key_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    executionAttemptTokenHash: {
      type: DataTypes.STRING(64),
      allowNull: true,
      field: 'execution_attempt_token_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    status: {
      type: DataTypes.ENUM('queued', 'running', 'completed', 'accepted', 'failed'),
      allowNull: false,
      defaultValue: 'queued',
    },
    proposal: { type: DataTypes.JSON, allowNull: true },
    proposalHash: {
      type: DataTypes.STRING(64),
      allowNull: true,
      field: 'proposal_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    provenance: { type: DataTypes.JSON, allowNull: true },
    errorSummary: { type: DataTypes.JSON, allowNull: true, field: 'error_summary' },
    jobRequestId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, field: 'job_request_id' },
    acceptedContentEntryId: {
      type: DataTypes.STRING(36),
      allowNull: true,
      field: 'accepted_content_entry_id',
      validate: { isUUID: 4 },
    },
    acceptedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'accepted_by_user_id' },
    startedAt: { type: DataTypes.DATE, allowNull: true, field: 'started_at' },
    completedAt: { type: DataTypes.DATE, allowNull: true, field: 'completed_at' },
    acceptedAt: { type: DataTypes.DATE, allowNull: true, field: 'accepted_at' },
    expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
  }, {
    tableName: 'WebContentGenerations',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    validate: {
      coherentScope() {
        validateClinicScope(this);
      },
    },
    indexes: [
      { fields: ['clinica_id', 'created_at'] },
      { fields: ['grupo_clinica_id', 'created_at'] },
      { fields: ['status', 'expires_at'] },
      { fields: ['input_hash'] },
      { fields: ['idempotency_key_hash'], unique: true },
      { fields: ['job_request_id'], unique: true },
      { fields: ['accepted_content_entry_id'], unique: true },
    ],
  });

  WebContentGeneration.associate = function associate(models) {
    WebContentGeneration.belongsTo(models.Clinica, {
      foreignKey: 'clinicaId',
      targetKey: 'id_clinica',
      as: 'clinica',
    });
    WebContentGeneration.belongsTo(models.GrupoClinica, {
      foreignKey: 'grupoClinicaId',
      targetKey: 'id_grupo',
      as: 'grupoClinica',
    });
    WebContentGeneration.belongsTo(models.Usuario, {
      foreignKey: 'requestedByUserId',
      targetKey: 'id_usuario',
      as: 'requestedBy',
    });
    WebContentGeneration.belongsTo(models.Usuario, {
      foreignKey: 'acceptedByUserId',
      targetKey: 'id_usuario',
      as: 'acceptedBy',
    });
    WebContentGeneration.belongsTo(models.JobRequest, {
      foreignKey: 'jobRequestId',
      as: 'jobRequest',
    });
    WebContentGeneration.belongsTo(models.WebContentEntry, {
      foreignKey: 'acceptedContentEntryId',
      as: 'acceptedContent',
    });
  };

  return WebContentGeneration;
};
