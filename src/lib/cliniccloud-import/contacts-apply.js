'use strict';

// Deliberately narrow: three-way, non-empty corrections of ALREADY linked
// patients. No creates, merges, primary-clinic, clinical or consent changes.
const { hash, dateOnly } = require('./adapter');
const COLUMNS = Object.freeze({ name: 'nombre', surname: 'apellidos', email: 'email', phone: 'telefono_movil', national_id: 'dni', birth_date: 'fecha_nacimiento' });
const VERSION = 'cliniccloud-contact-patches/1';
function assert(condition, code) { if (!condition) throw new Error(code); }
function fieldsOf(row) {
  return Object.fromEntries(Object.entries(COLUMNS).map(([key, column]) => [key, key === 'birth_date' ? dateOnly(row[column]) || '' : row[column] || '']));
}
function validPatch(patch) {
  return patch && typeof patch === 'object' && !Array.isArray(patch) && Object.keys(patch).length > 0 && Object.entries(patch).every(([key, value]) => Object.hasOwn(COLUMNS, key) && typeof value === 'string' && value.trim().length > 0 && value.length <= 255 && !/[\u0000-\u001f]/.test(value) && (key !== 'birth_date' || dateOnly(value) === value));
}
function candidates(plan, snapshot) {
  assert(plan.plan_sha256 === hash({ manifest: plan.manifest, actions: plan.actions }), 'PLAN_HASH_MISMATCH');
  assert(plan.manifest.source_account === 'cliniccloud-5880' && snapshot.source_account === 'cliniccloud-5880', 'SOURCE_SCOPE_MISMATCH');
  assert(plan.manifest.snapshot_sha256 === hash(snapshot), 'SNAPSHOT_HASH_MISMATCH');
  assert(JSON.stringify([...snapshot.complete_for.clinic_ids].sort((a, b) => a - b)) === '[66,72]', 'CLINIC_SCOPE_MISMATCH');
  assert(plan.manifest.automation_policy === 'hold' && plan.manifest.physical_deletes === false && plan.manifest.whatsapp_column_policy === 'ignored_no_consent_mutation', 'IMPORT_POLICY_MISMATCH');
  const patients = new Map(snapshot.patients.map(p => [Number(p.id), p]));
  const selected = [];
  const seen = new Set();
  for (const action of plan.actions) {
    if (action.entity !== 'patient' || action.action !== 'link_patient' || !Object.keys(action.fields_patch || {}).length) continue;
    assert(!action.requires_review && !action.reasons.length && validPatch(action.fields_patch), 'UNREVIEWED_OR_INVALID_CONTACT_PATCH');
    const patient = patients.get(Number(action.local_id));
    assert(patient && [66, 72].includes(Number(patient.clinic_id)) && patient.source_contact_ids.map(String).includes(String(action.source_contact_id)), 'PATIENT_IDENTITY_MISMATCH');
    assert(!seen.has(patient.id), 'MULTIPLE_PATCHES_ONE_PATIENT');
    seen.add(patient.id);
    selected.push({ action_key: action.action_key, patient_id: patient.id, source_contact_id: action.source_contact_id, provenance: action.provenance, expected_fields: patient.fields, expected_clinic_id: patient.clinic_id, fields_patch: action.fields_patch });
  }
  return selected.sort((a, b) => a.patient_id - b.patient_id);
}
function sourceIds(rows) {
  const ids = new Set();
  for (const row of rows) {
    if (row.source !== 'cliniccloud') continue;
    if (row.source_column === 'idContacto' || row.field_key === 'cliniccloud_source_contact_id') ids.add(String(row.value || '').trim());
    if (row.source_column === 'contacto_1.csv') {
      try { const value = JSON.parse(row.value); if (value.contact?.idContacto) ids.add(String(value.contact.idContacto).trim()); } catch { /* not identity evidence */ }
    }
  }
  return [...ids].filter(Boolean).sort();
}
function validateCurrent(candidate, row, links) {
  assert(row && Number(row.id_paciente) === Number(candidate.patient_id) && Number(row.clinica_id) === Number(candidate.expected_clinic_id), 'PATIENT_ROW_OR_CLINIC_DRIFT');
  assert(hash(fieldsOf(row)) === hash(candidate.expected_fields), 'PATIENT_FIELDS_DRIFT');
  assert(sourceIds(links).includes(String(candidate.source_contact_id)), 'PATIENT_SOURCE_IDENTITY_DRIFT');
  assert(validPatch(candidate.fields_patch), 'INVALID_CONTACT_PATCH');
}
function packageHash(value) { const { package_sha256, ...body } = value; return hash(body); }
function validatePackage(value) {
  assert(value.version === VERSION && value.package_sha256 === packageHash(value), 'PACKAGE_HASH_MISMATCH');
  assert(value.source_account === 'cliniccloud-5880' && value.automation_policy === 'hold' && value.whatsapp_column_policy === 'ignored_no_consent_mutation', 'PACKAGE_POLICY_MISMATCH');
  assert(Array.isArray(value.operations) && value.operations.length > 0 && value.operations.length <= 200, 'BATCH_SIZE_INVALID');
  const seen = new Set();
  for (const op of value.operations) {
    assert(!seen.has(op.patient_id), 'MULTIPLE_PATCHES_ONE_PATIENT'); seen.add(op.patient_id);
    assert([66, 72].includes(Number(op.expected_clinic_id)) && validPatch(op.fields_patch) && op.before_sha256 === hash(op.before), 'OPERATION_INVALID');
    validateCurrent(op, op.before, op.identity_rows);
  }
}
module.exports = { COLUMNS, VERSION, candidates, fieldsOf, sourceIds, validPatch, validateCurrent, packageHash, validatePackage };
