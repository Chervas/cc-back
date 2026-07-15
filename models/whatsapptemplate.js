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
      display_name: {
        type: DataTypes.STRING(150),
        allowNull: true,
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
      variables: {
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
      pending_since_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      auto_resubmit_attempt_count: {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
      auto_resubmit_attempted_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      resubmitted_from_template_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      superseded_by_template_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      auto_resubmit_error: {
        type: DataTypes.TEXT,
        allowNull: true,
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
