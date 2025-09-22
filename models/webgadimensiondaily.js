'use strict';

module.exports = (sequelize, DataTypes) => {
  const WebGaDimensionDaily = sequelize.define('WebGaDimensionDaily', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    property_id: { type: DataTypes.INTEGER, allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    dimension_type: { type: DataTypes.STRING(64), allowNull: false },
    dimension_value: { type: DataTypes.STRING(256), allowNull: false },
    sessions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    active_users: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    conversions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    total_revenue: { type: DataTypes.DECIMAL(12,2), allowNull: true }
  }, {
    tableName: 'WebGaDimensionDaily',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  WebGaDimensionDaily.associate = function(models) {
    WebGaDimensionDaily.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
    WebGaDimensionDaily.belongsTo(models.ClinicAnalyticsProperty, { foreignKey: 'property_id', as: 'property' });
  };

  return WebGaDimensionDaily;
};
