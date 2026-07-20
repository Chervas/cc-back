'use strict';

const { validateWebContentEntry } = require('../src/lib/webContent');

function rejectMutation() {
  const error = new Error('WebContentEntryVersion es inmutable');
  error.code = 'WEB_CONTENT_ENTRY_VERSION_IMMUTABLE';
  throw error;
}

module.exports = (sequelize, DataTypes) => {
  const WebContentEntryVersion = sequelize.define('WebContentEntryVersion', {
    id: {
      type: DataTypes.STRING(36),
      allowNull: false,
      primaryKey: true,
      validate: { isUUID: 4 },
    },
    contentEntryId: { type: DataTypes.STRING(36), allowNull: false, field: 'content_entry_id' },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, validate: { min: 1 } },
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
    locale: { type: DataTypes.STRING(16), allowNull: false },
    title: { type: DataTypes.STRING(191), allowNull: false },
    content: { type: DataTypes.JSON, allowNull: false },
    sources: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    schemaConfig: {
      type: DataTypes.JSON,
      allowNull: true,
      field: 'schema_config',
    },
    contentHash: { type: DataTypes.STRING(64), allowNull: false, field: 'content_hash' },
    status: {
      type: DataTypes.ENUM('draft', 'review', 'published', 'archived'),
      allowNull: false,
    },
    actorUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'actor_user_id' },
  }, {
    tableName: 'WebContentEntryVersions',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
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
      beforeUpdate: rejectMutation,
      beforeDestroy: rejectMutation,
      beforeBulkUpdate: rejectMutation,
      beforeBulkDestroy: rejectMutation,
    },
    indexes: [
      { unique: true, fields: ['content_entry_id', 'version'] },
      { fields: ['content_entry_id', 'created_at'] },
      { fields: ['content_hash'] },
    ],
  });

  WebContentEntryVersion.associate = function associate(models) {
    WebContentEntryVersion.belongsTo(models.WebContentEntry, {
      foreignKey: 'contentEntryId',
      as: 'entry',
      onDelete: 'RESTRICT',
    });
    WebContentEntryVersion.belongsTo(models.Usuario, {
      foreignKey: 'actorUserId',
      targetKey: 'id_usuario',
      as: 'actor',
    });
  };

  return WebContentEntryVersion;
};
