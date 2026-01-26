'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class WhatsappTemplate extends Model {
    static associate(models) {
      WhatsappTemplate.belongsTo(models.WhatsappTemplateCatalog, {
        foreignKey: 'catalog_template_id',
        as: 'catalog',
      });
    }
  }

  WhatsappTemplate.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      waba_id: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      clinic_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      language: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      category: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      components: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      meta_template_id: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      catalog_template_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      origin: {
        type: DataTypes.ENUM('catalog', 'custom', 'external'),
        allowNull: false,
        defaultValue: 'catalog',
      },
      rejection_reason: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      last_synced_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'WhatsappTemplate',
      tableName: 'WhatsappTemplates',
      timestamps: true,
    }
  );

  return WhatsappTemplate;
};
