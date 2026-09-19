'use strict';
module.exports = (sequelize, D) => sequelize.define('SearchConsoleBrokerBinding', {
  site_hash: { type: D.CHAR(64), primaryKey: true, allowNull: false },
  site_url: { type: D.STRING(512), allowNull: false },
  mapping_id: { type: D.INTEGER, primaryKey: true, allowNull: false },
  connection_ref: { type: D.STRING(128), allowNull: false },
  asset_ref: { type: D.STRING(128), allowNull: false },
  clinica_id: { type: D.INTEGER, allowNull: false },
  google_connection_id: { type: D.INTEGER, allowNull: false },
  google_user_id: { type: D.STRING(128), allowNull: false },
  state: { type: D.ENUM('active', 'blocked'), allowNull: false, defaultValue: 'blocked' },
}, { tableName: 'SearchConsoleBrokerBindings', timestamps: false });
