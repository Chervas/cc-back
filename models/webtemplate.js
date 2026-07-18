'use strict';

const {
  attachWebDocumentIntegrityHook,
  scopeKeyFor,
  validateClinicScope,
} = require('../src/lib/webDocumentModel');

module.exports = (sequelize, DataTypes) => {
  const WebTemplate = sequelize.define('WebTemplate', {
    id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      primaryKey: true,
      validate: { isUUID: 4 },
    },
    scopeType: {
      type: DataTypes.ENUM('global', 'clinic', 'group'),
      allowNull: false,
      field: 'scope_type',
    },
    clinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'clinica_id' },
    grupoClinicaId: { type: DataTypes.INTEGER, allowNull: true, field: 'grupo_clinica_id' },
    scopeKey: { type: DataTypes.STRING(64), allowNull: false, field: 'scope_key' },
    catalogKey: {
      type: DataTypes.STRING(128),
      allowNull: false,
      field: 'catalog_key',
      validate: { is: /^[a-z0-9][a-z0-9_-]{2,127}$/ },
    },
    name: { type: DataTypes.STRING(191), allowNull: false, validate: { len: [1, 191] } },
    description: { type: DataTypes.TEXT, allowNull: true },
    category: {
      type: DataTypes.STRING(64),
      allowNull: false,
      validate: { is: /^[a-z0-9][a-z0-9_-]{1,63}$/ },
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
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1, validate: { min: 1 } },
    compatibility: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    previewAssetId: { type: DataTypes.INTEGER, allowNull: true, field: 'preview_asset_id' },
    isPublic: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: 'is_public' },
    status: {
      type: DataTypes.ENUM('draft', 'active', 'archived'),
      allowNull: false,
      defaultValue: 'draft',
    },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by_user_id' },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by_user_id' },
  }, {
    tableName: 'WebTemplates',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    deletedAt: 'deleted_at',
    paranoid: true,
    validate: {
      coherentScope() {
        validateClinicScope(this, { allowGlobal: true });
        if (this.scopeKey !== scopeKeyFor(this, { allowGlobal: true })) {
          throw new Error('scope_key no coincide con el alcance de la plantilla');
        }
      },
    },
    indexes: [
      { unique: true, fields: ['scope_key', 'catalog_key', 'version'] },
      { fields: ['status', 'category', 'is_public'] },
      { fields: ['document_hash'] },
    ],
  });

  WebTemplate.addHook('beforeValidate', 'deriveWebTemplateScopeKey', (template) => {
    template.set('scopeKey', scopeKeyFor(template, { allowGlobal: true }));
  });
  attachWebDocumentIntegrityHook(WebTemplate);

  WebTemplate.associate = function associate(models) {
    WebTemplate.belongsTo(models.Clinica, {
      foreignKey: 'clinicaId',
      targetKey: 'id_clinica',
      as: 'clinica',
    });
    WebTemplate.belongsTo(models.GrupoClinica, {
      foreignKey: 'grupoClinicaId',
      targetKey: 'id_grupo',
      as: 'grupoClinica',
    });
    WebTemplate.belongsTo(models.Usuario, {
      foreignKey: 'createdByUserId',
      targetKey: 'id_usuario',
      as: 'createdBy',
    });
    WebTemplate.belongsTo(models.Usuario, {
      foreignKey: 'updatedByUserId',
      targetKey: 'id_usuario',
      as: 'updatedBy',
    });
    WebTemplate.hasMany(models.WebPage, { foreignKey: 'templateId', as: 'pages' });
  };

  return WebTemplate;
};
