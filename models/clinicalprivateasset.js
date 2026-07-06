'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ClinicalPrivateAsset extends Model {
    static associate(models) {
      ClinicalPrivateAsset.belongsTo(models.Clinica, {
        foreignKey: 'clinic_id',
        targetKey: 'id_clinica',
        as: 'clinic',
      });
      ClinicalPrivateAsset.belongsTo(models.GrupoClinica, {
        foreignKey: 'group_id',
        targetKey: 'id_grupo',
        as: 'group',
      });
      ClinicalPrivateAsset.belongsTo(models.Paciente, {
        foreignKey: 'patient_id',
        targetKey: 'id_paciente',
        as: 'patient',
      });
      ClinicalPrivateAsset.belongsTo(models.Usuario, {
        foreignKey: 'created_by',
        targetKey: 'id_usuario',
        as: 'createdByUser',
      });
    }
  }

  ClinicalPrivateAsset.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(80), allowNull: false, unique: true },
    scope_type: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'clinic' },
    clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    group_id: { type: DataTypes.INTEGER, allowNull: true },
    patient_id: { type: DataTypes.INTEGER, allowNull: true },
    owner_type: { type: DataTypes.STRING(80), allowNull: true },
    owner_id: { type: DataTypes.STRING(128), allowNull: true },
    purpose: { type: DataTypes.STRING(80), allowNull: false },
    provider: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'local_private' },
    bucket: { type: DataTypes.STRING(255), allowNull: false },
    region: { type: DataTypes.STRING(64), allowNull: true },
    object_key: { type: DataTypes.STRING(768), allowNull: false },
    original_filename: { type: DataTypes.STRING(255), allowNull: true },
    content_type: { type: DataTypes.STRING(128), allowNull: false },
    size_bytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    sha256: { type: DataTypes.STRING(64), allowNull: false },
    encryption_status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'provider_managed' },
    sensitivity: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'clinical_private' },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'active' },
    metadata: { type: DataTypes.JSON, allowNull: true },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'ClinicalPrivateAsset',
    tableName: 'ClinicalPrivateAssets',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return ClinicalPrivateAsset;
};
