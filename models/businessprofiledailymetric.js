'use strict';

module.exports = (sequelize, DataTypes) => {
  const BusinessProfileDailyMetric = sequelize.define('BusinessProfileDailyMetric', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    business_location_id: { type: DataTypes.INTEGER, allowNull: false },
    metric_type: { type: DataTypes.STRING(64), allowNull: false },
    metric_subtype: { type: DataTypes.STRING(64), allowNull: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    value: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: 'BusinessProfileDailyMetrics',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  BusinessProfileDailyMetric.associate = function(models) {
    BusinessProfileDailyMetric.belongsTo(models.ClinicBusinessLocation, { foreignKey: 'business_location_id', as: 'location' });
    BusinessProfileDailyMetric.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
  };

  return BusinessProfileDailyMetric;
};
