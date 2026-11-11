'use strict';
module.exports = (sequelize, D) => sequelize.define('BusinessProfileAssociationScope', {
  scope_key: { type: D.STRING(64), primaryKey: true, allowNull: false },
  clinica_id: { type: D.INTEGER, allowNull: false }, google_connection_id: { type: D.INTEGER, allowNull: false },
  google_user_id: { type: D.STRING(128), allowNull: false }, connection_ref: { type: D.STRING(128), allowNull: false },
  scope_ref: { type: D.STRING(128), allowNull: false }, account_ids: { type: D.JSON, allowNull: false },
  location_ids: { type: D.JSON, allowNull: false }, state: { type: D.ENUM('blocked','active'), allowNull: false, defaultValue: 'blocked' },
}, { tableName: 'BusinessProfileAssociationScopes', timestamps: false });
