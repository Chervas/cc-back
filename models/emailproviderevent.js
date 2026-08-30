'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class EmailProviderEvent extends Model {
    static associate(models) {
      if (models.EmailMessage) {
        EmailProviderEvent.belongsTo(models.EmailMessage, { foreignKey: 'email_message_id', as: 'emailMessage' });
      }
    }
  }

  EmailProviderEvent.init({
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    email_message_id: DataTypes.INTEGER.UNSIGNED,
    provider: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'ses' },
    provider_message_id: DataTypes.STRING(255),
    provider_event_id: DataTypes.STRING(191),
    event_type: { type: DataTypes.STRING(64), allowNull: false },
    severity: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'info' },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    payload_summary: DataTypes.JSON,
  }, {
    sequelize,
    modelName: 'EmailProviderEvent',
    tableName: 'EmailProviderEvents',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return EmailProviderEvent;
};
