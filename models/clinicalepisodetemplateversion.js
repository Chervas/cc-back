'use strict';
module.exports = (sequelize, D) => sequelize.define('ClinicalEpisodeTemplateVersion', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, template_id: { type: D.BIGINT.UNSIGNED, allowNull: false },
  version_number: { type: D.INTEGER.UNSIGNED, allowNull: false }, snapshot: { type: D.JSON, allowNull: false },
  sha256: { type: D.STRING(64), allowNull: false }, actor_id: { type: D.INTEGER, allowNull: false },
}, { tableName: 'ClinicalEpisodeTemplateVersions', underscored: true, createdAt: 'created_at', updatedAt: false,
  hooks: { beforeUpdate() { throw Error('clinical_template_version_immutable'); }, beforeDestroy() { throw Error('clinical_template_version_immutable'); },
    beforeBulkUpdate() { throw Error('clinical_template_version_immutable'); }, beforeBulkDestroy() { throw Error('clinical_template_version_immutable'); } } });
