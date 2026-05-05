'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketingContactOptOut extends Model {
    static associate(models) {
      MarketingContactOptOut.belongsTo(models.Clinica, {
        foreignKey: 'clinica_id',
        targetKey: 'id_clinica',
        as: 'clinica',
      });
      MarketingContactOptOut.belongsTo(models.Paciente, {
        foreignKey: 'paciente_id',
        targetKey: 'id_paciente',
        as: 'paciente',
      });
      MarketingContactOptOut.belongsTo(models.Message, {
        foreignKey: 'trigger_message_id',
        targetKey: 'id',
        as: 'triggerMessage',
      });
      MarketingContactOptOut.belongsTo(models.Message, {
        foreignKey: 'inbound_message_id',
        targetKey: 'id',
        as: 'inboundMessage',
      });
    }
  }

  MarketingContactOptOut.init({
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    clinica_id: { type: DataTypes.INTEGER, allowNull: false },
    paciente_id: { type: DataTypes.INTEGER, allowNull: true },
    phone: { type: DataTypes.STRING(64), allowNull: true },
    phone_digits: { type: DataTypes.STRING(32), allowNull: false },
    channel: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'whatsapp' },
    scope: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'marketing' },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'active' },
    reason_text: { type: DataTypes.TEXT, allowNull: true },
    source: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'whatsapp_inbound' },
    trigger_message_id: { type: DataTypes.INTEGER, allowNull: true },
    inbound_message_id: { type: DataTypes.INTEGER, allowNull: true },
    trigger_list_id: { type: DataTypes.INTEGER, allowNull: true },
    trigger_item_id: { type: DataTypes.INTEGER, allowNull: true },
    trigger_objective_id: { type: DataTypes.STRING(64), allowNull: true },
    opted_out_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, {
    sequelize,
    modelName: 'MarketingContactOptOut',
    tableName: 'MarketingContactOptOuts',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return MarketingContactOptOut;
};
