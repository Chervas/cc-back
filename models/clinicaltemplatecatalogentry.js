'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicalTemplateCatalogEntry', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  public_id: { type: D.STRING(36), allowNull: false, unique: true },
  catalog_key: { type: D.STRING(80), allowNull: false, unique: true },
  current_version: { type: D.INTEGER.UNSIGNED, allowNull: false },
  published_version: { type: D.INTEGER.UNSIGNED, allowNull: true },
  created_by: { type: D.INTEGER, allowNull: false }, updated_by: { type: D.INTEGER, allowNull: false },
}, { tableName: 'ClinicalTemplateCatalogEntries', underscored: true, createdAt: 'created_at', updatedAt: 'updated_at' });
