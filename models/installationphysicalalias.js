'use strict';
module.exports = (sequelize, DataTypes) => sequelize.define('InstallationPhysicalAlias', {
  installation_id: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false },
  canonical_installation_id: { type: DataTypes.INTEGER, allowNull: false },
  group_id: { type: DataTypes.INTEGER, allowNull: false },
}, { tableName: 'InstallationPhysicalAliases', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
