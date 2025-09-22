'use strict';

module.exports = (sequelize, DataTypes) => {
  const WebGaDaily = sequelize.define('WebGaDaily', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    property_id: { type: DataTypes.INTEGER, allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    sessions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    active_users: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    new_users: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    conversions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    total_revenue: { type: DataTypes.DECIMAL(12,2), allowNull: true }
  }, {
    tableName: 'WebGaDaily',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  WebGaDaily.associate = function(models) {
    WebGaDaily.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
    WebGaDaily.belongsTo(models.ClinicAnalyticsProperty, { foreignKey: 'property_id', as: 'property' });
  };

  return WebGaDaily;
};
