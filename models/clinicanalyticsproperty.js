'use strict';

module.exports = (sequelize, DataTypes) => {
  const ClinicAnalyticsProperty = sequelize.define('ClinicAnalyticsProperty', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinicaId: { type: DataTypes.INTEGER, allowNull: false, field: 'clinicaId' },
    googleConnectionId: { type: DataTypes.INTEGER, allowNull: false, field: 'googleConnectionId' },
    propertyName: { type: DataTypes.STRING(128), allowNull: false, field: 'propertyName' },
    propertyDisplayName: { type: DataTypes.STRING(256), allowNull: true, field: 'propertyDisplayName' },
    propertyType: { type: DataTypes.STRING(32), allowNull: true, field: 'propertyType' },
    parent: { type: DataTypes.STRING(128), allowNull: true, field: 'parent' },
    measurementId: { type: DataTypes.STRING(128), allowNull: true, field: 'measurementId' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: 'isActive' }
  }, {
    tableName: 'ClinicAnalyticsProperties',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['clinicaId'] },
      { fields: ['googleConnectionId'] },
      { unique: true, fields: ['clinicaId', 'propertyName'] }
    ]
  });

  ClinicAnalyticsProperty.associate = function(models) {
    ClinicAnalyticsProperty.belongsTo(models.Clinica, { foreignKey: 'clinicaId', targetKey: 'id_clinica', as: 'clinica' });
    ClinicAnalyticsProperty.belongsTo(models.GoogleConnection, { foreignKey: 'googleConnectionId', targetKey: 'id', as: 'connection' });
  };

  return ClinicAnalyticsProperty;
};
