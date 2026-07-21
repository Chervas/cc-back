'use strict';

const { validateClinicScope } = require('../src/lib/webDocumentModel');
const { validateWebContentEntry } = require('../src/lib/webContent');

module.exports = (sequelize, DataTypes) => {
  const WebContentEntry = sequelize.define('WebContentEntry', {
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
    type: {
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
    },
    locale: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'es-ES',
      validate: { is: /^[a-z]{2,3}(?:-[A-Z]{2})?$/ },
    },
    title: { type: DataTypes.STRING(191), allowNull: false, validate: { len: [1, 191] } },
    content: { type: DataTypes.JSON, allowNull: false },
    sources: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    schemaConfig: {
      type: DataTypes.JSON,
      allowNull: true,
      field: 'schema_config',
    },
    contentHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: 'content_hash',
      validate: { is: /^[a-f0-9]{64}$/ },
    },
    status: {
      type: DataTypes.ENUM('draft', 'review', 'published', 'archived'),
      allowNull: false,
      defaultValue: 'draft',
    },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1, validate: { min: 1 } },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by_user_id' },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by_user_id' },
  }, {
    tableName: 'WebContentEntries',
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
      beforeValidate(instance) {
        const normalized = validateWebContentEntry({
          type: instance.type,
          locale: instance.locale,
          title: instance.title,
          content: instance.content,
          sources: instance.sources,
          schema_config: instance.schemaConfig,
        });
        instance.type = normalized.type;
        instance.locale = normalized.locale;
        instance.title = normalized.title;
        instance.content = normalized.content;
        instance.sources = normalized.sources;
        instance.schemaConfig = normalized.schema_config;
        instance.contentHash = normalized.hash;
      },
    },
    indexes: [
      { fields: ['clinica_id', 'status', 'updated_at'] },
      { fields: ['grupo_clinica_id', 'status', 'updated_at'] },
      { fields: ['type', 'locale', 'status'] },
      { fields: ['owner_user_id', 'status'] },
      { fields: ['content_hash'] },
    ],
  });

  WebContentEntry.associate = function associate(models) {
    WebContentEntry.belongsTo(models.Clinica, {
      foreignKey: 'clinicaId',
      targetKey: 'id_clinica',
      as: 'clinica',
    });
    WebContentEntry.belongsTo(models.GrupoClinica, {
      foreignKey: 'grupoClinicaId',
      targetKey: 'id_grupo',
      as: 'grupoClinica',
    });
    WebContentEntry.belongsTo(models.Usuario, {
      foreignKey: 'ownerUserId',
      targetKey: 'id_usuario',
      as: 'owner',
    });
    WebContentEntry.belongsTo(models.Usuario, {
      foreignKey: 'createdByUserId',
      targetKey: 'id_usuario',
      as: 'createdBy',
    });
    WebContentEntry.belongsTo(models.Usuario, {
      foreignKey: 'updatedByUserId',
      targetKey: 'id_usuario',
      as: 'updatedBy',
    });
    WebContentEntry.hasMany(models.WebContentEntryVersion, {
      foreignKey: 'contentEntryId',
      as: 'versions',
    });
  };

  return WebContentEntry;
};
