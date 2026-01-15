'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MessageTemplate extends Model {
    static associate(models) {
      MessageTemplate.belongsTo(models.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica' });
      MessageTemplate.hasMany(models.MessageLog, { foreignKey: 'template_id', as: 'logs' });
    }
  }

  MessageTemplate.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    nombre: { type: DataTypes.STRING(255), allowNull: false },
    tipo: { type: DataTypes.ENUM('whatsapp', 'email', 'sms'), allowNull: false },
    contenido: { type: DataTypes.TEXT, allowNull: false },
    estado: { type: DataTypes.ENUM('pendiente', 'aprobada', 'rechazada'), allowNull: false, defaultValue: 'pendiente' },
    uso: { type: DataTypes.STRING(128), allowNull: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: true }
  }, {
    sequelize,
    modelName: 'MessageTemplate',
    tableName: 'MessageTemplates',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at'
  });

  return MessageTemplate;
};
