'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class WhatsappTemplate extends Model {
    static associate(models) {
      // opcional: asociación por wabaId si se quiere
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
        allowNull: false,
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
