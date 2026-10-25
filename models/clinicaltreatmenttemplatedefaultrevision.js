'use strict';
const immutable = () => { throw Error('clinical_template_default_revision_immutable'); };
module.exports = (sequelize, D) => sequelize.define('ClinicalTreatmentTemplateDefaultRevision', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, preference_id: { type: D.BIGINT.UNSIGNED, allowNull: false },
  clinic_id: { type: D.INTEGER, allowNull: false }, version_number: { type: D.INTEGER.UNSIGNED, allowNull: false }, snapshot: { type: D.JSON, allowNull: false },
  actor_id: { type: D.INTEGER, allowNull: false }, command_key: { type: D.STRING(120), allowNull: false }, command_hash: { type: D.STRING(64), allowNull: false },
}, { tableName: 'ClinicalTreatmentTemplateDefaultRevisions', underscored: true, createdAt: 'created_at', updatedAt: false,
  hooks: { beforeUpdate: immutable, beforeDestroy: immutable, beforeBulkUpdate: immutable, beforeBulkDestroy: immutable } });
