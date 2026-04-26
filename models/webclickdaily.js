'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class WebClickDaily extends Model {}

  WebClickDaily.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    clinic_id: { type: DataTypes.INTEGER, allowNull: true },
    group_id: { type: DataTypes.INTEGER, allowNull: true },
    date: { type: DataTypes.DATEONLY, allowNull: false },
    domain: { type: DataTypes.STRING(255), allowNull: true },
    page_url: { type: DataTypes.STRING(1024), allowNull: true },
    click_type: { type: DataTypes.STRING(80), allowNull: false },
    target: { type: DataTypes.STRING(512), allowNull: true },
    clicks: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    unique_sessions: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  }, {
    sequelize,
    modelName: 'WebClickDaily',
    tableName: 'WebClickDaily',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return WebClickDaily;
};
