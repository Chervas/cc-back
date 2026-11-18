'use strict';

const { hash } = require('./adapter');
const { sourceKey } = require('../patientFollowUps.contract');
const ROLE = 'followup_date_reconciliation';
const VERSION = 'cliniccloud-followup-source-date-reconciliation/v1';
const RULE = 'newer_export_changed_contact_date';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hex = value => /^[a-f0-9]{64}$/.test(value || '');
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value + 'T00:00:00Z'));
const provenance = value => value && hex(value.file_sha256) && hex(value.row_sha256) && Number.isInteger(value.source_row) && value.source_row > 0;

function validateDocument({ document: d, file, sourceFiles, sourceManifestHash }) {
  if (d?.version !== VERSION || d.rule !== RULE || d.source_account !== 'cliniccloud-5880'
    || d.authorization_kind !== 'explicit_operator_resolution_for_authorized_import'
    || !d.authorized_by || !d.recorded_by || !d.authorization_reference || !Number.isFinite(Date.parse(d.recorded_at))
    || !Number.isInteger(d.patient_id) || d.patient_id < 1 || !/^[1-9]\d*$/.test(d.source_contact_id || '')
    || !/^[1-9]\d*$/.test(d.history_number || '') || !/^[1-9]\d*$/.test(d.historical?.source_external_id || '')
    || !provenance(d.selected?.provenance) || !provenance(d.historical?.provenance) || !hex(d.body_sha256)
    || !day(d.selected.contact_due_date) || !day(d.historical.contact_due_date)
    || d.selected.contact_due_date === d.historical.contact_due_date || d.selected.status !== 'closed'
    || typeof d.historical.state_raw !== 'string' || !d.historical.state_raw
    || !hex(d.alias_source_key) || d.chosen_source !== 'newer_export' || d.keep_notifications_off !== true
    || d.preserve_primary_clinics_and_memberships !== true) fail('FOLLOWUP_DATE_RECONCILIATION_INVALID');
  if (!file || file.role !== ROLE || !sourceFiles.some(f => f.role === ROLE && f.sha256 === file.sha256)
    || d.source_manifest_sha256 !== sourceManifestHash(sourceFiles)
    || !sourceFiles.some(f => f.sha256 === d.selected.provenance.file_sha256)
    || !sourceFiles.some(f => f.sha256 === d.historical.provenance.file_sha256)) fail('FOLLOWUP_DATE_RECONCILIATION_MANIFEST_CHANGED');
  const alias = `row:${d.selected.provenance.file_sha256}:${d.selected.provenance.source_row}:${d.selected.provenance.row_sha256}`;
  if (sourceKey('cliniccloud_alert','cliniccloud-5880',alias) !== d.alias_source_key) fail('FOLLOWUP_DATE_RECONCILIATION_ALIAS_INVALID');
  return { ...d, file_sha256: file.sha256, document_sha256: hash(d),
    canonical_source_reference: `alert:${d.historical.source_external_id}`, alias_source_keys: [d.alias_source_key] };
}

function assertRecord(proof, record, sourceFiles = null) {
  if (!proof || proof.version !== VERSION || proof.rule !== RULE || proof.source_account !== 'cliniccloud-5880'
    || !hex(proof.file_sha256) || !hex(proof.document_sha256) || proof.selected?.status !== 'closed'
    || Number(record.patient_id) !== proof.patient_id || record.source_contact_id !== proof.source_contact_id
    || record.history_number !== proof.history_number || record.source_status !== proof.selected.status
    || record.contact_due_date !== proof.selected.contact_due_date || hash(require('./adapter').norm(record.clinical_notes)) !== proof.body_sha256
    || record.source_reference !== proof.canonical_source_reference
    || hash(record.provenance) !== hash(proof.selected.provenance)
    || JSON.stringify(proof.alias_source_keys) !== JSON.stringify([proof.alias_source_key])
    || proof.canonical_source_reference !== `alert:${proof.historical?.source_external_id}`) fail('FOLLOWUP_DATE_RECONCILIATION_RECORD_CHANGED');
  if (sourceFiles && !sourceFiles.some(file => file.role === ROLE && file.sha256 === proof.file_sha256)) fail('FOLLOWUP_DATE_RECONCILIATION_FILE_REQUIRED');
}

module.exports = { ROLE, VERSION, RULE, validateDocument, assertRecord };
