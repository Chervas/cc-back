'use strict';
module.exports = (sequelize, D) => sequelize.define('PatientClinicalMedicationRevision', {
  id: { type: D.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true }, medication_id: D.BIGINT.UNSIGNED, version_number: D.INTEGER.UNSIGNED,
  snapshot: D.JSON, command_key: D.STRING(120), command_hash: D.STRING(64), clinic_id: D.INTEGER, actor_id: D.INTEGER,
}, { tableName: 'PatientClinicalMedicationRevisions', underscored: true, createdAt: 'created_at', updatedAt: false, hooks: {
  beforeUpdate() { throw Error('clinical_medication_revision_immutable'); }, beforeDestroy() { throw Error('clinical_medication_revision_immutable'); },
  beforeBulkUpdate() { throw Error('clinical_medication_revision_immutable'); }, beforeBulkDestroy() { throw Error('clinical_medication_revision_immutable'); },
} });
