'use strict';

const { validateClinicScope } = require('../src/lib/webDocumentModel');
const { canonicalSerialize } = require('../src/lib/webDocument');
const { validateWebMediaPresentation } = require('../src/lib/webContent');

module.exports = (sequelize, DataTypes) => {
  const WebMediaAsset = sequelize.define('WebMediaAsset', {
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
    publicMediaAssetId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'public_media_asset_id',
    },
    ownerUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'owner_user_id' },
    title: { type: DataTypes.STRING(191), allowNull: false, validate: { len: [1, 191] } },
    kind: {
      type: DataTypes.ENUM('image'),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('processing', 'ready', 'failed', 'archived'),
      allowNull: false,
      defaultValue: 'ready',
    },
    altText: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '', field: 'alt_text' },
    decorative: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    focalPoints: { type: DataTypes.JSON, allowNull: false, defaultValue: {}, field: 'focal_points' },
    rights: { type: DataTypes.JSON, allowNull: false },
    variants: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    mediaMetadata: { type: DataTypes.JSON, allowNull: false, defaultValue: {}, field: 'media_metadata' },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1, validate: { min: 1 } },
    createdByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'created_by_user_id' },
    updatedByUserId: { type: DataTypes.INTEGER, allowNull: true, field: 'updated_by_user_id' },
  }, {
    tableName: 'WebMediaAssets',
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    validate: {
      coherentScope() {
        validateClinicScope(this);
      },
    },
    hooks: {
      beforeValidate(instance) {
        const normalized = validateWebMediaPresentation({
          title: instance.title,
          alt_text: instance.altText,
          decorative: instance.decorative,
          focal_points: instance.focalPoints,
          rights: instance.rights,
        });
        instance.title = normalized.title;
        instance.altText = normalized.alt_text;
        instance.decorative = normalized.decorative;
        instance.focalPoints = normalized.focal_points;
        instance.rights = normalized.rights;
        if (!Array.isArray(instance.variants) || instance.variants.length > 30) {
          throw new Error('WebMediaAsset.variants debe ser una lista de hasta 30 variantes');
        }
        canonicalSerialize({ variants: instance.variants, media_metadata: instance.mediaMetadata || {} });
      },
    },
    indexes: [
      { unique: true, fields: ['public_media_asset_id'] },
      { fields: ['clinica_id', 'status', 'created_at'] },
      { fields: ['grupo_clinica_id', 'status', 'created_at'] },
      { fields: ['kind', 'status'] },
    ],
  });

  WebMediaAsset.associate = function associate(models) {
    WebMediaAsset.belongsTo(models.PublicMediaAsset, {
      foreignKey: 'publicMediaAssetId',
      as: 'publicMediaAsset',
      onDelete: 'RESTRICT',
    });
    WebMediaAsset.belongsTo(models.Clinica, {
      foreignKey: 'clinicaId',
      targetKey: 'id_clinica',
      as: 'clinica',
    });
    WebMediaAsset.belongsTo(models.GrupoClinica, {
      foreignKey: 'grupoClinicaId',
      targetKey: 'id_grupo',
      as: 'grupoClinica',
    });
    WebMediaAsset.belongsTo(models.Usuario, {
      foreignKey: 'ownerUserId',
      targetKey: 'id_usuario',
      as: 'owner',
    });
    WebMediaAsset.belongsTo(models.Usuario, {
      foreignKey: 'createdByUserId',
      targetKey: 'id_usuario',
      as: 'createdBy',
    });
    WebMediaAsset.belongsTo(models.Usuario, {
      foreignKey: 'updatedByUserId',
      targetKey: 'id_usuario',
      as: 'updatedBy',
    });
  };

  return WebMediaAsset;
};
