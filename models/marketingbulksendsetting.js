'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketingBulkSendSetting extends Model {}

  MarketingBulkSendSetting.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      scope_key: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: 'global',
      },
      settings: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: {},
      },
      blocked_users: {
        type: DataTypes.JSON,
        allowNull: true,
      },
      updated_by: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'MarketingBulkSendSetting',
      tableName: 'MarketingBulkSendSettings',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      underscored: true,
    }
  );

  return MarketingBulkSendSetting;
};
