'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class WhatsappTemplateCatalogDiscipline extends Model {
    static associate(models) {
      WhatsappTemplateCatalogDiscipline.belongsTo(models.WhatsappTemplateCatalog, {
        foreignKey: 'template_catalog_id',
        as: 'catalog',
      });
    }
  }

  WhatsappTemplateCatalogDiscipline.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      template_catalog_id: { type: DataTypes.INTEGER, allowNull: false },
      disciplina_code: { type: DataTypes.STRING(50), allowNull: false },
    },
    {
      sequelize,
      modelName: 'WhatsappTemplateCatalogDiscipline',
      tableName: 'WhatsappTemplateCatalogDisciplines',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return WhatsappTemplateCatalogDiscipline;
};
