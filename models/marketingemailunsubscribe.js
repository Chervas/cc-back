'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketingEmailUnsubscribe extends Model {}
  MarketingEmailUnsubscribe.init({
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    email_hash: { type: DataTypes.CHAR(64), allowNull: false },
    scope_key: { type: DataTypes.STRING(64), allowNull: false },
    clinica_id: DataTypes.INTEGER,
    grupo_clinica_id: DataTypes.INTEGER,
    list_id: DataTypes.INTEGER,
    item_id: DataTypes.INTEGER,
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'issued' },
    unsubscribed_at: DataTypes.DATE,
  }, {
    sequelize,
    modelName: 'MarketingEmailUnsubscribe',
    tableName: 'MarketingEmailUnsubscribes',
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return MarketingEmailUnsubscribe;
};
