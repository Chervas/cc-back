'use strict';

module.exports = (sequelize, DataTypes) => {
  const ClinicWebAsset = sequelize.define('ClinicWebAsset', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinicaId: { type: DataTypes.INTEGER, allowNull: false, field: 'clinicaId' },
    googleConnectionId: { type: DataTypes.INTEGER, allowNull: false, field: 'googleConnectionId' },
    siteUrl: { type: DataTypes.STRING(512), allowNull: false, field: 'siteUrl' },
    propertyType: { type: DataTypes.STRING(32), allowNull: true, field: 'propertyType' }, // 'sc-domain' | 'url-prefix'
    permissionLevel: { type: DataTypes.STRING(64), allowNull: true, field: 'permissionLevel' },
    verified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'verified' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'isActive' }
  }, {
    tableName: 'ClinicWebAssets',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['clinicaId'] },
      { fields: ['googleConnectionId'] },
      { unique: true, fields: ['clinicaId','siteUrl'] }
    ]
  });

  ClinicWebAsset.associate = function(models) {
    ClinicWebAsset.belongsTo(models.Clinica, { foreignKey: 'clinicaId', targetKey: 'id_clinica', as: 'clinica' });
    ClinicWebAsset.belongsTo(models.GoogleConnection, { foreignKey: 'googleConnectionId', targetKey: 'id', as: 'connection' });
  };

  return ClinicWebAsset;
};
