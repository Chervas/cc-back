'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AccessPolicyOverride extends Model {}

  AccessPolicyOverride.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      scope_type: {
        type: DataTypes.ENUM('group', 'clinic'),
        allowNull: false,
      },
      scope_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      feature_key: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      role_code: {
        type: DataTypes.STRING(64),
        allowNull: false,
      },
      effect: {
        type: DataTypes.ENUM('allow', 'deny'),
        allowNull: false,
      },
      updated_by: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'AccessPolicyOverride',
      tableName: 'AccessPolicyOverrides',
      underscored: true,
      timestamps: true,
    },
  );

  return AccessPolicyOverride;
};

