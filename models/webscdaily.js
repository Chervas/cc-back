'use strict';

module.exports = (sequelize, DataTypes) => {
  const WebScDaily = sequelize.define('WebScDaily', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    site_url: { type: DataTypes.STRING(512), allowNull: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    impressions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    ctr: { type: DataTypes.DECIMAL(8,6), allowNull: false, defaultValue: 0 },
    position: { type: DataTypes.DECIMAL(8,3), allowNull: true }
  }, {
    tableName: 'WebScDaily',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [
      { fields: ['clinica_id','date'] },
      { fields: ['site_url'] },
      { unique: true, fields: ['clinica_id','site_url','date'], name: 'uniq_websc_clinic_site_date' }
    ]
  });
  return WebScDaily;
};

