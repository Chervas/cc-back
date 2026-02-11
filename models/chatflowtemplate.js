'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ChatFlowTemplate extends Model {
    static associate(models) {
      // No associations for now (catalog is global).
    }
  }

  ChatFlowTemplate.init(
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(255), allowNull: false, unique: true },
      tags: { type: DataTypes.JSON, allowNull: true },
      // Códigos de disciplina (sector) para controlar visibilidad por tipo de clínica.
      // Si es null o [] => visible para todas.
      disciplina_codes: { type: DataTypes.JSON, allowNull: true },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      flow: { type: DataTypes.JSON, allowNull: true },
      flows: { type: DataTypes.JSON, allowNull: true },
      texts: { type: DataTypes.JSON, allowNull: true },
      appearance: { type: DataTypes.JSON, allowNull: true },
    },
    {
      sequelize,
      modelName: 'ChatFlowTemplate',
      tableName: 'ChatFlowTemplates',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return ChatFlowTemplate;
};
