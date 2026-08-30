'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class SystemNotificationDelivery extends Model {
    static associate(models) {
      if (models.ClinicMetaAsset) {
        SystemNotificationDelivery.belongsTo(models.ClinicMetaAsset, {
          foreignKey: 'whatsapp_sender_asset_id',
          as: 'whatsappSender',
        });
      }
      if (models.EmailMessage) {
        SystemNotificationDelivery.belongsTo(models.EmailMessage, {
          foreignKey: 'email_message_id',
          as: 'emailMessage',
        });
      }
      if (models.JobRequest) {
        SystemNotificationDelivery.belongsTo(models.JobRequest, {
          foreignKey: 'job_request_id',
          as: 'jobRequest',
        });
      }
    }
  }

  SystemNotificationDelivery.init({
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    event_key: { type: DataTypes.STRING(120), allowNull: false },
    severity: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'info' },
    channel: { type: DataTypes.STRING(24), allowNull: false },
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'queued' },
    title: { type: DataTypes.STRING(255), allowNull: false },
    message: DataTypes.TEXT,
    action: DataTypes.TEXT,
    recipient_hash: DataTypes.CHAR(64),
    recipient_label: DataTypes.STRING(120),
    recipient_domain: DataTypes.STRING(255),
    whatsapp_sender_asset_id: DataTypes.INTEGER,
    whatsapp_template_name: DataTypes.STRING(100),
    email_message_id: DataTypes.INTEGER.UNSIGNED,
    job_request_id: DataTypes.INTEGER.UNSIGNED,
    provider: DataTypes.STRING(32),
    provider_message_id: DataTypes.STRING(255),
    error_code: DataTypes.STRING(120),
    error_message: DataTypes.TEXT,
    metadata: DataTypes.JSON,
    queued_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    sent_at: DataTypes.DATE,
    failed_at: DataTypes.DATE,
    completed_at: DataTypes.DATE,
  }, {
    sequelize,
    modelName: 'SystemNotificationDelivery',
    tableName: 'SystemNotificationDeliveries',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return SystemNotificationDelivery;
};
