'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class WebPageDaily extends Model {}

  WebPageDaily.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    group_id: { type: DataTypes.INTEGER, allowNull: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    domain: { type: DataTypes.STRING(255), allowNull: true },
    page_url: { type: DataTypes.STRING(1024), allowNull: true },
    page_path: { type: DataTypes.STRING(512), allowNull: true },
    page_title: { type: DataTypes.STRING(512), allowNull: true },
    pageviews: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    unique_sessions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    unique_visitors: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    tel_clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    whatsapp_clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    form_submits: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    leads: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    sequelize,
    modelName: 'WebPageDaily',
    tableName: 'WebPageDaily',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return WebPageDaily;
};
