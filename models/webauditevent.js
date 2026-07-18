'use strict';

const { validateClinicScope } = require('../src/lib/webDocumentModel');

function appendOnlyError() {
  const error = new Error('WebAuditEvent es append-only');
  error.code = 'WEB_AUDIT_EVENT_APPEND_ONLY';
  throw error;
}

module.exports = (sequelize, DataTypes) => {
  const WebAuditEvent = sequelize.define('WebAuditEvent', {
    id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, autoIncrement: true, primaryKey: true },
    projectId: { type: DataTypes.STRING(36), allowNull: true, field: 'project_id' },
    scopeType: {
      type: DataTypes.ENUM('global', 'clinic', 'group'),
      allowNull: false,
      field: 'scope_type',
    },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinica_id' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupo_clinica_id' },
    actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
    eventType: {
      type: DataTypes.STRING(128),
      allowNull: false,
      field: 'event_type',
      validate: { is: /^[a-z][a-z0-9_.-]{2,127}$/ },
    },
    entityType: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: 'entity_type',
      validate: { is: /^[a-z][a-z0-9_.-]{1,63}$/ },
    },
    entityId: { type: DataTypes.STRING(64), allowNull: true, field: 'entity_id' },
    requestId: { type: DataTypes.STRING(80), allowNull: true, field: 'request_id' },
    previousHash: {
      type: DataTypes.STRING(64),
      allowNull: true,
      field: 'previous_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    nextHash: {
      type: DataTypes.STRING(64),
      allowNull: true,
      field: 'next_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    metadata: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
  }, {
    tableName: 'WebAuditEvents',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
    validate: {
      coherentScope() {
        validateClinicScope(this, { allowGlobal: true });
      },
    },
    indexes: [
      { fields: ['project_id', 'created_at'] },
      { fields: ['clinica_id', 'created_at'] },
      { fields: ['grupo_clinica_id', 'created_at'] },
      { fields: ['event_type', 'created_at'] },
      { fields: ['request_id'] },
    ],
    hooks: {
      beforeUpdate: appendOnlyError,
      beforeDestroy: appendOnlyError,
      beforeBulkUpdate: appendOnlyError,
      beforeBulkDestroy: appendOnlyError,
    },
  });

  WebAuditEvent.associate = function associate(models) {
    WebAuditEvent.belongsTo(models.WebProject, {
      foreignKey: 'projectId',
      as: 'project',
      onDelete: 'RESTRICT',
    });
    WebAuditEvent.belongsTo(models.Clinica, {
      foreignKey: 'clinicaId',
      targetKey: 'id_clinica',
      as: 'clinica',
    });
    WebAuditEvent.belongsTo(models.GrupoClinica, {
      foreignKey: 'grupoClinicaId',
      targetKey: 'id_grupo',
      as: 'grupoClinica',
    });
    WebAuditEvent.belongsTo(models.Usuario, {
      foreignKey: 'actorUserId',
      targetKey: 'id_usuario',
      as: 'actor',
    });
  };

  return WebAuditEvent;
};
