'use strict';

module.exports = (sequelize, DataTypes) => {
  const WebScDailyAgg = sequelize.define('WebScDailyAgg', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    queries_top10: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    queries_top3: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 }
  }, {
    tableName: 'WebScDailyAgg',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [ { unique: true, fields: ['clinica_id','date'], name: 'uniq_webscagg_clinic_date' } ]
  });
  return WebScDailyAgg;
};

