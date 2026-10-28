'use strict';
module.exports = (sequelize, D) => sequelize.define('GoogleAdsEnrollmentScope', {
  scope_key: { type: D.STRING(64), primaryKey: true, allowNull: false },
  google_connection_id: { type: D.INTEGER, allowNull: false },
  google_user_id: { type: D.STRING(128), allowNull: false },
  connection_ref: { type: D.STRING(128), allowNull: false },
  asset_ref: { type: D.STRING(128), allowNull: false },
  tenant_clinic_id: { type: D.INTEGER, allowNull: false },
  root_customer_id: { type: D.CHAR(10), allowNull: false },
  login_customer_id: { type: D.CHAR(10), allowNull: true },
  state: { type: D.ENUM('blocked', 'active'), allowNull: false, defaultValue: 'blocked' },
}, { tableName: 'GoogleAdsEnrollmentScopes', timestamps: false });
