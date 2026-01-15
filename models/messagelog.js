'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MessageLog extends Model {
    static associate(models) {
      MessageLog.belongsTo(models.MessageTemplate, { foreignKey: 'template_id', as: 'template' });
      MessageLog.belongsTo(models.AutomationFlow, { foreignKey: 'flow_id', as: 'flow' });
    }
  }

  MessageLog.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    template_id: { type: DataTypes.INTEGER, allowNull: true },
    flow_id: { type: DataTypes.INTEGER, allowNull: true },
    destinatario: { type: DataTypes.STRING(255), allowNull: false },
    tipo: { type: DataTypes.ENUM('whatsapp', 'email', 'sms'), allowNull: false },
    estado: { type: DataTypes.ENUM('enviado', 'entregado', 'leido', 'fallido'), allowNull: false, defaultValue: 'enviado' },
    metadata: { type: DataTypes.JSON, allowNull: true }
  }, {
    sequelize,
    modelName: 'MessageLog',
    tableName: 'MessageLogs',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return MessageLog;
};
