'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketingEmailTemplateCatalog extends Model {
    static associate(models) {
      MarketingEmailTemplateCatalog.hasMany(models.MarketingEmailTemplate, {
        foreignKey: 'catalog_template_id',
        as: 'instances',
      });
    }
  }

  MarketingEmailTemplateCatalog.init({
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    public_id: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    catalog_key: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(160), allowNull: false },
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'ready' },
    subject: { type: DataTypes.STRING(160), allowNull: false },
    preheader: DataTypes.STRING(255),
    layout_key: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'classic' },
    design: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    rendered_html: DataTypes.TEXT('long'),
    rendered_text: DataTypes.TEXT('long'),
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    propagation_state: DataTypes.STRING(24),
    last_propagated_at: DataTypes.DATE,
    created_by: DataTypes.INTEGER,
    updated_by: DataTypes.INTEGER,
  }, {
    sequelize,
    modelName: 'MarketingEmailTemplateCatalog',
    tableName: 'MarketingEmailTemplateCatalog',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return MarketingEmailTemplateCatalog;
};
