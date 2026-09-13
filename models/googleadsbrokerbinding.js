'use strict';
module.exports = (sequelize, D) => sequelize.define('GoogleAdsBrokerBinding', {
  customer_id: { type: D.CHAR(10), primaryKey: true, allowNull: false },
  mapping_id: { type: D.INTEGER, primaryKey: true, allowNull: false },
  google_connection_id: { type: D.INTEGER, allowNull: false },
  google_user_id: { type: D.STRING(128), allowNull: false },
  connection_ref: { type: D.STRING(128), allowNull: false },
  asset_ref: { type: D.STRING(128), allowNull: false },
  scope_key: { type: D.STRING(64), allowNull: false },
  tenant_clinic_id: { type: D.INTEGER, allowNull: false },
  login_customer_id: { type: D.CHAR(10), allowNull: true },
  state: { type: D.ENUM('active', 'blocked', 'staged'), allowNull: false, defaultValue: 'blocked' },
}, { tableName: 'GoogleAdsBrokerBindings', timestamps: false });
