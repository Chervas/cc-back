'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicalTemplateCatalogAdoption', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, clinic_id: { type: D.INTEGER, allowNull: false },
  entry_id: { type: D.BIGINT.UNSIGNED, allowNull: false }, source_version_id: { type: D.BIGINT.UNSIGNED, allowNull: false },
  source_version: { type: D.INTEGER.UNSIGNED, allowNull: false }, source_sha256: { type: D.STRING(64), allowNull: false },
  local_template_id: { type: D.BIGINT.UNSIGNED, allowNull: false }, local_version: { type: D.INTEGER.UNSIGNED, allowNull: false },
  actor_id: { type: D.INTEGER, allowNull: false },
}, { tableName: 'ClinicalTemplateCatalogAdoptions', underscored: true, createdAt: 'created_at', updatedAt: false,
  hooks: { beforeUpdate() { throw Error('clinical_catalog_adoption_immutable'); }, beforeDestroy() { throw Error('clinical_catalog_adoption_immutable'); },
    beforeBulkUpdate() { throw Error('clinical_catalog_adoption_immutable'); }, beforeBulkDestroy() { throw Error('clinical_catalog_adoption_immutable'); } } });
