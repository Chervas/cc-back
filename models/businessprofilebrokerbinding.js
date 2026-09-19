'use strict';
// No FK cascade: deleting a legacy mapping/connection must not restore legacy reads.
module.exports = (sequelize, DataTypes) => sequelize.define('BusinessProfileBrokerBinding', {
  external_location_id: { type: DataTypes.STRING(30), primaryKey: true },
  connection_ref: { type: DataTypes.STRING(128), allowNull: false },
  asset_ref: { type: DataTypes.STRING(128), allowNull: false },
  clinica_id: { type: DataTypes.INTEGER, allowNull: false },
  google_connection_id: { type: DataTypes.INTEGER, allowNull: false },
}, { tableName: 'BusinessProfileBrokerBindings', timestamps: false });
