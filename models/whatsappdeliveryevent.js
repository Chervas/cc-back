'use strict';

module.exports = (sequelize, DataTypes) => sequelize.define('WhatsappDeliveryEvent', {
  id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  dedupe_key: { type: DataTypes.STRING(64), allowNull: false, unique: true },
  event_type: { type: DataTypes.STRING(96), allowNull: false },
  source: { type: DataTypes.STRING(96), allowNull: false },
  severity: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'info' },
  business_portfolio_id: { type: DataTypes.STRING(255), allowNull: true },
  waba_id: { type: DataTypes.STRING(255), allowNull: true },
  phone_number_id: { type: DataTypes.STRING(255), allowNull: true },
  meta_template_id: { type: DataTypes.STRING(255), allowNull: true },
  template_name: { type: DataTypes.STRING(255), allowNull: true },
  template_language: { type: DataTypes.STRING(32), allowNull: true },
  list_id: { type: DataTypes.INTEGER, allowNull: true },
  item_id: { type: DataTypes.INTEGER, allowNull: true },
  message_id: { type: DataTypes.INTEGER, allowNull: true },
  reason_code: { type: DataTypes.STRING(96), allowNull: true },
  status: { type: DataTypes.STRING(64), allowNull: true },
  payload: { type: DataTypes.JSON, allowNull: true },
  occurred_at: { type: DataTypes.DATE, allowNull: false },
}, {
  tableName: 'WhatsappDeliveryEvents',
  underscored: true,
  timestamps: true,
});
