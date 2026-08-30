'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class SystemNotificationSetting extends Model {
    static associate(models) {
      if (models.ClinicMetaAsset) {
        SystemNotificationSetting.belongsTo(models.ClinicMetaAsset, {
          foreignKey: 'whatsapp_sender_asset_id',
          as: 'whatsappSender',
        });
      }
    }
  }

  SystemNotificationSetting.init({
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    scope: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'global', unique: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    panel_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    email_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    whatsapp_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    admin_email: DataTypes.STRING(320),
    admin_phone: DataTypes.STRING(40),
    whatsapp_sender_asset_id: DataTypes.INTEGER,
    whatsapp_template_name: { type: DataTypes.STRING(100), allowNull: false, defaultValue: 'clinicaclick_admin_alerta_sistema' },
    whatsapp_template_language: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'es' },
    throttle_minutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 60 },
    event_rules: DataTypes.JSON,
    last_checked_at: DataTypes.DATE,
    last_tested_at: DataTypes.DATE,
  }, {
    sequelize,
    modelName: 'SystemNotificationSetting',
    tableName: 'SystemNotificationSettings',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return SystemNotificationSetting;
};
