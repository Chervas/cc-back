'use strict';

module.exports = (sequelize, D) => sequelize.define('DpdWorkspaceEntry', {
  key: { type: D.STRING(96), primaryKey: true },
  value: { type: D.JSON, allowNull: false },
  revision: { type: D.INTEGER.UNSIGNED, allowNull: false },
  updated_by: { type: D.INTEGER.UNSIGNED, allowNull: false },
  updated_at: { type: D.DATE, allowNull: false },
}, { tableName: 'DpdWorkspaceEntries', timestamps: false });
