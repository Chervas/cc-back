'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PublicMediaAsset extends Model {
    static associate(models) {
      PublicMediaAsset.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      PublicMediaAsset.belongsTo(models.GrupoClinica, { foreignKey: 'grupo_clinica_id', targetKey: 'id_grupo', as: 'grupoClinica' });
      PublicMediaAsset.belongsTo(models.Usuario, { foreignKey: 'created_by', targetKey: 'id_usuario', as: 'createdByUser' });
    }
  }

  PublicMediaAsset.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    scope_type: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'clinic' },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    grupo_clinica_id: { type: DataTypes.INTEGER, allowNull: true },
    owner_type: { type: DataTypes.STRING(64), allowNull: true },
    owner_id: { type: DataTypes.STRING(128), allowNull: true },
    purpose: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'public_asset' },
    provider: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 's3_cloudfront' },
    bucket: { type: DataTypes.STRING(255), allowNull: false },
    region: { type: DataTypes.STRING(64), allowNull: false },
    object_key: { type: DataTypes.STRING(768), allowNull: false },
    public_url: { type: DataTypes.TEXT, allowNull: false },
    content_type: { type: DataTypes.STRING(128), allowNull: false },
    size_bytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    sha256: { type: DataTypes.STRING(64), allowNull: false },
    etag: { type: DataTypes.STRING(255), allowNull: true },
    cache_control: { type: DataTypes.STRING(255), allowNull: true },
    sensitivity: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'public' },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'active' },
    metadata: { type: DataTypes.JSON, allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'PublicMediaAsset',
    tableName: 'PublicMediaAssets',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return PublicMediaAsset;
};
