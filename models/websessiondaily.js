'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class WebSessionDaily extends Model {}

  WebSessionDaily.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    group_id: { type: DataTypes.INTEGER, allowNull: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    domain: { type: DataTypes.STRING(255), allowNull: true },
    sessions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    visitors: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    pageviews: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    tel_clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    whatsapp_clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    form_submits: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    sequelize,
    modelName: 'WebSessionDaily',
    tableName: 'WebSessionDaily',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return WebSessionDaily;
};
