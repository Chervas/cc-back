'use strict';

const { validateClinicScope } = require('../src/lib/webDocumentModel');

function campaignContextImmutableError() {
  const error = new Error('campaign_context es inmutable despues de crear el proyecto');
  error.code = 'WEB_PROJECT_CAMPAIGN_CONTEXT_IMMUTABLE';
  return error;
}

module.exports = (sequelize, DataTypes) => {
  const WebProject = sequelize.define('WebProject', {
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
    ownerUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'owner_user_id' },
    name: { type: DataTypes.STRING(191), allowNull: false, validate: { len: [1, 191] } },
    purpose: {
      type: DataTypes.ENUM('landing', 'microsite', 'website'),
      allowNull: false,
      defaultValue: 'landing',
    },
    locale: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'es-ES',
      validate: { is: /^[a-z]{2,3}(?:-[A-Z]{2})?$/ },
    },
    status: {
      type: DataTypes.ENUM('draft', 'active', 'archived'),
      allowNull: false,
      defaultValue: 'draft',
    },
    campaignContext: {
      type: DataTypes.JSON,
      allowNull: true,
      field: 'campaign_context',
    },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1, validate: { min: 1 } },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by_user_id' },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by_user_id' },
  }, {
    tableName: 'WebProjects',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    deletedAt: 'deleted_at',
    paranoid: true,
    validate: {
      coherentScope() {
        validateClinicScope(this);
      },
    },
    hooks: {
      beforeUpdate(instance) {
        if (!instance.changed('campaignContext')) return;
        throw campaignContextImmutableError();
      },
      beforeBulkUpdate(options = {}) {
        const attributes = options.attributes || {};
        if (
          Object.prototype.hasOwnProperty.call(attributes, 'campaignContext')
          || Object.prototype.hasOwnProperty.call(attributes, 'campaign_context')
        ) throw campaignContextImmutableError();
      },
    },
    indexes: [
      { fields: ['clinica_id', 'status', 'deleted_at'] },
      { fields: ['grupo_clinica_id', 'status', 'deleted_at'] },
      { fields: ['owner_user_id', 'status'] },
    ],
  });

  WebProject.associate = function associate(models) {
    WebProject.belongsTo(models.Clinica, {
      foreignKey: 'clinicaId',
      targetKey: 'id_clinica',
      as: 'clinica',
    });
    WebProject.belongsTo(models.GrupoClinica, {
      foreignKey: 'grupoClinicaId',
      targetKey: 'id_grupo',
      as: 'grupoClinica',
    });
    WebProject.belongsTo(models.Usuario, {
      foreignKey: 'ownerUserId',
      targetKey: 'id_usuario',
      as: 'owner',
    });
    WebProject.belongsTo(models.Usuario, {
      foreignKey: 'createdByUserId',
      targetKey: 'id_usuario',
      as: 'createdBy',
    });
    WebProject.belongsTo(models.Usuario, {
      foreignKey: 'updatedByUserId',
      targetKey: 'id_usuario',
      as: 'updatedBy',
    });
    WebProject.hasMany(models.WebPage, { foreignKey: 'projectId', as: 'pages' });
    WebProject.hasOne(models.WebDraft, { foreignKey: 'projectId', as: 'draft' });
    WebProject.hasMany(models.WebRevision, { foreignKey: 'projectId', as: 'revisions' });
    if (models.WebArtifact) {
      WebProject.hasMany(models.WebArtifact, { foreignKey: 'projectId', as: 'artifacts' });
    }
    if (models.WebPublication) {
      WebProject.hasMany(models.WebPublication, { foreignKey: 'projectId', as: 'publications' });
    }
    WebProject.hasMany(models.WebAuditEvent, { foreignKey: 'projectId', as: 'auditEvents' });
  };

  return WebProject;
};
