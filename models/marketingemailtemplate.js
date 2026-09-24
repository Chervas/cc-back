'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketingEmailTemplate extends Model {}
  MarketingEmailTemplate.init({
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    scope_type: { type: DataTypes.STRING(16), allowNull: false },
    scope_key: { type: DataTypes.STRING(64), allowNull: false },
    clinica_id: DataTypes.INTEGER,
    grupo_clinica_id: DataTypes.INTEGER,
    name: { type: DataTypes.STRING(160), allowNull: false },
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'draft' },
    subject: { type: DataTypes.STRING(160), allowNull: false },
    preheader: DataTypes.STRING(255),
    layout_key: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'classic' },
    design: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    rendered_html: DataTypes.TEXT('long'),
    rendered_text: DataTypes.TEXT('long'),
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    created_by: DataTypes.INTEGER,
    updated_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'MarketingEmailTemplate',
    tableName: 'MarketingEmailTemplates',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return MarketingEmailTemplate;
};
