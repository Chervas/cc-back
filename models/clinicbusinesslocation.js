'use strict';

module.exports = (sequelize, DataTypes) => {
  const ClinicBusinessLocation = sequelize.define('ClinicBusinessLocation', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    google_connection_id: { type: DataTypes.INTEGER, allowNull: false },
    location_name: { type: DataTypes.STRING(256), allowNull: true },
    location_id: { type: DataTypes.STRING(256), allowNull: false },
    store_code: { type: DataTypes.STRING(128), allowNull: true },
    primary_category: { type: DataTypes.STRING(256), allowNull: true },
    sync_status: { type: DataTypes.STRING(32), allowNull: true },
    is_verified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    is_suspended: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    raw_payload: { type: DataTypes.JSON, allowNull: true },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    last_synced_at: { type: DataTypes.DATE, allowNull: true }
  }, {
    tableName: 'ClinicBusinessLocations',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  ClinicBusinessLocation.associate = function(models) {
    ClinicBusinessLocation.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
    ClinicBusinessLocation.belongsTo(models.GoogleConnection, { foreignKey: 'google_connection_id', as: 'googleConnection' });
    ClinicBusinessLocation.hasMany(models.BusinessProfileDailyMetric, { foreignKey: 'business_location_id', as: 'metrics' });
    ClinicBusinessLocation.hasMany(models.BusinessProfileReview, { foreignKey: 'business_location_id', as: 'reviews' });
    ClinicBusinessLocation.hasMany(models.BusinessProfilePost, { foreignKey: 'business_location_id', as: 'posts' });
  };

  return ClinicBusinessLocation;
};
