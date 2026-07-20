'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class WhatsappTemplateCatalog extends Model {
    static associate(models) {
      WhatsappTemplateCatalog.hasMany(models.WhatsappTemplate, {
        foreignKey: 'catalog_template_id',
        as: 'instances',
      });
      WhatsappTemplateCatalog.hasMany(models.WhatsappTemplateCatalogDiscipline, {
        foreignKey: 'template_catalog_id',
        as: 'disciplinas',
      });
    }
  }

  WhatsappTemplateCatalog.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
      family_key: { type: DataTypes.STRING(100), allowNull: false },
      locale: { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'es' },
      display_name: { type: DataTypes.STRING(150), allowNull: true },
      category: { type: DataTypes.ENUM('UTILITY', 'MARKETING'), allowNull: false },
      body_text: { type: DataTypes.TEXT, allowNull: false },
      variables: { type: DataTypes.JSON, allowNull: true },
      components: { type: DataTypes.JSON, allowNull: true },
      last_propagated_at: { type: DataTypes.DATE, allowNull: true },
      propagation_state: { type: DataTypes.STRING(24), allowNull: true },
      is_generic: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    },
    {
      sequelize,
      modelName: 'WhatsappTemplateCatalog',
      tableName: 'WhatsappTemplateCatalog',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          name: 'uniq_whatsapp_template_catalog_family_locale',
          unique: true,
          fields: ['family_key', 'locale'],
        },
      ],
    }
  );

  return WhatsappTemplateCatalog;
};
