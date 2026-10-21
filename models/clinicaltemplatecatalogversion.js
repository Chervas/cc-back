'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicalTemplateCatalogVersion', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
  entry_id: { type: D.BIGINT.UNSIGNED, allowNull: false }, version_number: { type: D.INTEGER.UNSIGNED, allowNull: false },
  snapshot: { type: D.JSON, allowNull: false }, sha256: { type: D.STRING(64), allowNull: false },
  published_at: { type: D.DATE, allowNull: true }, actor_id: { type: D.INTEGER, allowNull: false },
}, { tableName: 'ClinicalTemplateCatalogVersions', underscored: true, createdAt: 'created_at', updatedAt: false,
  hooks: { beforeUpdate() { throw Error('clinical_catalog_version_immutable'); }, beforeDestroy() { throw Error('clinical_catalog_version_immutable'); },
    beforeBulkUpdate() { throw Error('clinical_catalog_version_immutable'); }, beforeBulkDestroy() { throw Error('clinical_catalog_version_immutable'); } } });
