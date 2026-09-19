'use strict';
module.exports = (sequelize, D) => sequelize.define('BusinessProfileCacheState', {
  resource_key: { type: D.CHAR(64), primaryKey: true, allowNull: false },
  epoch: { type: D.UUID, allowNull: false },
  observation_ref: { type: D.UUID, allowNull: true },
  pending_count: { type: D.INTEGER, allowNull: false, defaultValue: 0 },
}, { tableName: 'BusinessProfileCacheStates', timestamps: false });
