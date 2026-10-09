'use strict';

// Administrative source retention only: no clinical-form, consent, appointment,
// voucher or accounting writer. Existing values and source identities are immutable.
const { hash, dateOnly } = require('./adapter');
const VERSION = 'cliniccloud-patient-history-archive/1';
const SOURCE_ACCOUNT = 'cliniccloud-5880';
const CLINICS = [66, 72];
const NATIVE_FIELDS = Object.freeze({
  nombre: 'NOMBRE', apellidos: 'APELLIDOS', dni: 'DNI', email: 'EMAIL',
  telefono_movil: 'TELF. MOVIL', telefono_secundario: 'TELF. FIJO',
  fecha_nacimiento: 'F. NACIMIENTO', sexo: 'SEXO', profesion: 'PROFESION',
});

function positiveId(value) {
  const text = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}
function blank(value) { return value === null || value === undefined || (typeof value === 'string' && !value.trim()); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function documentKey(value) { return text(value).normalize('NFKC').toUpperCase().replace(/[\s.-]/g, ''); }
function linkedClinicIds(patient, memberships) {
  return [...new Set([positiveId(patient.clinica_id), ...memberships.filter(row => Number(row.paciente_id) === Number(patient.id_paciente)).map(row => positiveId(row.clinica_id))].filter(Boolean))].sort((a, b) => a - b);
}
function identityLinks(fields) {
  return fields.filter(row => row.source === 'cliniccloud' && (row.source_column === 'idContacto' || row.field_key === 'cliniccloud_source_contact_id'));
}
function nativePatch(patient, contact, { today, birthDateHold = false } = {}) {
  const patch = {};
  for (const [field, source] of Object.entries(NATIVE_FIELDS)) {
    if (!blank(patient[field])) continue;
    let value = text(contact[source]);
    if (!value || value.length > 255 || /[\u0000-\u001f]/.test(value)) continue;
    if (field === 'fecha_nacimiento') {
      value = dateOnly(value);
      const registered = dateOnly(contact.ALTA);
      if (birthDateHold || !value || value < '1900-01-01' || value > today || (registered && value > registered)) continue;
    }
    if (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) continue;
    if (field.startsWith('telefono_') && (!/^[+\d\s().-]+$/.test(value) || value.replace(/\D/g, '').length < 7 || value.replace(/\D/g, '').length > 15)) continue;
    if (field === 'sexo') {
      // Source M is masculine, not the Spanish abbreviation for mujer.
      value = ({ M: 'hombre', F: 'mujer' })[value.toUpperCase()];
      if (!value) continue;
    }
    patch[field] = value;
  }
  return patch;
}

function buildArchivePlan({ source, patients, sourceLinks, memberships, existingArchives = [], birthDateHolds = [], today }) {
  if (source.account !== SOURCE_ACCOUNT || !/^BACKUP_CONTACTOS_\d{4}-\d{2}-\d{2}\.csv$/.test(source.name) || dateOnly(source.date) !== source.date || !/^[a-f0-9]{64}$/.test(source.sha256)) throw Error('SOURCE_SCOPE_OR_PROOF_INVALID');
  if (dateOnly(today) !== today) throw Error('EXPLICIT_TODAY_REQUIRED');
  const byId = new Map(patients.map(patient => [Number(patient.id_paciente), patient]));
  const owners = new Map();
  const linksBySource = new Map(), linksByPatient = new Map(), membershipsByPatient = new Map(), archivesByKey = new Map();
  for (const member of memberships) {
    const id = Number(member.paciente_id);
    if (!membershipsByPatient.has(id)) membershipsByPatient.set(id, []);
    membershipsByPatient.get(id).push(member);
  }
  for (const archive of existingArchives) {
    const key = `${archive.paciente_id}:${archive.field_key}`;
    if (!archivesByKey.has(key)) archivesByKey.set(key, []);
    archivesByKey.get(key).push(archive);
  }
  for (const link of identityLinks(sourceLinks)) {
    const id = positiveId(link.value);
    if (!id) continue;
    if (!owners.has(id)) owners.set(id, new Set());
    owners.get(id).add(Number(link.paciente_id));
    if (!linksBySource.has(id)) linksBySource.set(id, []);
    linksBySource.get(id).push(link);
    const patientId = Number(link.paciente_id);
    if (!linksByPatient.has(patientId)) linksByPatient.set(patientId, []);
    linksByPatient.get(patientId).push(link);
  }
  const occurrences = new Map();
  for (const row of source.rows) {
    const id = positiveId(row.values.IDCONTACTO);
    if (id) occurrences.set(id, (occurrences.get(id) || 0) + 1);
  }
  const holds = [], operations = [], unchanged = [], birthHolds = new Set(birthDateHolds);
  for (const row of source.rows) {
    const contact = row.values, id = positiveId(contact.IDCONTACTO);
    const hold = reason => holds.push({ source_row: row.source_row, source_contact_id: id, reason });
    if (!id) { hold('invalid_source_id'); continue; }
    if (occurrences.get(id) !== 1) { hold('duplicate_source_id'); continue; }
    const ownerIds = [...(owners.get(id) || [])];
    if (ownerIds.length !== 1) { hold(ownerIds.length ? 'ambiguous_source_owner' : 'unlinked_source_identity'); continue; }
    const patient = byId.get(ownerIds[0]);
    if (!patient) { hold('owner_outside_authorized_bs_scope'); continue; }
    const patientMemberships = membershipsByPatient.get(Number(patient.id_paciente)) || [];
    const linked = linkedClinicIds(patient, patientMemberships).filter(value => CLINICS.includes(value));
    const ownedLinks = (linksBySource.get(id) || []).filter(link => Number(link.paciente_id) === Number(patient.id_paciente));
    const linkedSourceClinics = linked.filter(clinic => ownedLinks.some(link => Number(link.clinica_id) === clinic));
    if (!linkedSourceClinics.length) { hold('source_link_without_real_clinic_membership'); continue; }
    const scopeClinic = linkedSourceClinics.includes(Number(patient.clinica_id)) ? Number(patient.clinica_id) : linkedSourceClinics[0];
    if (!blank(patient.dni) && text(contact.DNI) && documentKey(patient.dni) !== documentKey(contact.DNI)) { hold('source_document_differs_from_current_patient'); continue; }
    const fieldKey = `cliniccloud_history_contact_${source.date.replaceAll('-', '')}_${id}`;
    const snapshot = { version: 'cliniccloud_patient_history/1', source_account: SOURCE_ACCOUNT, source_date: source.date, contact,
      provenance: { source_file_name: source.name, source_file_sha256: source.sha256, source_row: row.source_row, source_row_sha256: hash(contact) } };
    const value = JSON.stringify(snapshot);
    if (Buffer.byteLength(value, 'utf8') > 65000) { hold('source_record_exceeds_text_storage_limit'); continue; }
    const archived = archivesByKey.get(`${patient.id_paciente}:${fieldKey}`) || [];
    if (archived.length > 1 || (archived.length === 1 && (Number(archived[0].clinica_id) !== scopeClinic || archived[0].value !== value))) { hold('immutable_archive_conflict'); continue; }
    const allPatientLinks = linksByPatient.get(Number(patient.id_paciente)) || [];
    const hasAliases = new Set(allPatientLinks.map(item => positiveId(item.value))).size > 1;
    const fieldsPatch = hasAliases ? {} : nativePatch(patient, contact, { today, birthDateHold: birthHolds.has(Number(patient.id_paciente)) });
    if (archived.length && !Object.keys(fieldsPatch).length) { unchanged.push({ source_contact_id: id, patient_id: Number(patient.id_paciente) }); continue; }
    operations.push({ patient_id: Number(patient.id_paciente), source_contact_id: id, clinic_id: scopeClinic,
      expected_patient_sha256: hash(patient), expected_memberships_sha256: hash(patientMemberships),
      expected_identity_links_sha256: hash(allPatientLinks), source_row_sha256: hash(contact), field_key: fieldKey, value,
      archive_exists: archived.length === 1, fields_patch: fieldsPatch });
  }
  // Retain aliases but do not choose which alias supplies demographics. Their
  // original records remain separately identifiable and no native row changes.
  const operationsPerPatient = new Map();
  for (const item of operations) operationsPerPatient.set(item.patient_id, (operationsPerPatient.get(item.patient_id) || 0) + 1);
  for (const item of operations) if (operationsPerPatient.get(item.patient_id) > 1) item.fields_patch = {};
  const body = { version: VERSION, source_account: SOURCE_ACCOUNT, source_file: source.name, source_sha256: source.sha256, source_date: source.date,
    prepared_at: new Date().toISOString(), today, policy: { fill_only_empty_native_fields: true, source_identity_only: true, archive_immutable: true,
      clinical_forms_created: 0, messages_sent: 0, consent_or_opt_in_changes: 0, economic_changes: 0, appointments_changed: 0 }, operations, holds, unchanged };
  return { ...body, plan_sha256: hash(body) };
}
function validatePlan(plan) {
  const { plan_sha256, ...body } = plan;
  if (plan.version !== VERSION || plan.source_account !== SOURCE_ACCOUNT || hash(body) !== plan_sha256) throw Error('ARCHIVE_PLAN_PROOF_INVALID');
  if (!Number.isFinite(Date.parse(plan.prepared_at)) || Date.now() - Date.parse(plan.prepared_at) > 2 * 3600000 || Date.parse(plan.prepared_at) > Date.now()) throw Error('ARCHIVE_PLAN_STALE');
  const seen = new Set();
  const counts = new Map();
  for (const item of plan.operations) counts.set(item.patient_id, (counts.get(item.patient_id) || 0) + 1);
  for (const item of plan.operations) {
    const key = `${item.patient_id}:${item.field_key}`;
    if (seen.has(key)) throw Error('DUPLICATE_ARCHIVE_OPERATION');
    seen.add(key);
    if (Object.keys(item.fields_patch).length && counts.get(item.patient_id) > 1) throw Error('MULTIPLE_SOURCE_DEMOGRAPHICS_REQUIRE_REVIEW');
  }
  for (const item of plan.operations) {
    if (!CLINICS.includes(item.clinic_id) || !positiveId(item.patient_id) || !positiveId(item.source_contact_id) || Object.keys(item.fields_patch).some(key => !Object.hasOwn(NATIVE_FIELDS, key))) throw Error('ARCHIVE_OPERATION_OUTSIDE_ALLOWLIST');
    let snapshot;
    try { snapshot = JSON.parse(item.value); } catch { throw Error('ARCHIVE_SOURCE_RECORD_INVALID'); }
    const proof = snapshot?.provenance;
    if (snapshot?.version !== 'cliniccloud_patient_history/1' || snapshot.source_account !== SOURCE_ACCOUNT || snapshot.source_date !== plan.source_date
      || positiveId(snapshot.contact?.IDCONTACTO) !== item.source_contact_id || proof?.source_file_name !== plan.source_file || proof.source_file_sha256 !== plan.source_sha256
      || proof.source_row_sha256 !== hash(snapshot.contact) || item.source_row_sha256 !== proof.source_row_sha256
      || item.field_key !== `cliniccloud_history_contact_${plan.source_date.replaceAll('-', '')}_${item.source_contact_id}`) throw Error('ARCHIVE_SOURCE_RECORD_PROOF_INVALID');
    const sourcePatch = nativePatch({}, snapshot.contact, { today: plan.today });
    for (const [key, value] of Object.entries(item.fields_patch)) if (sourcePatch[key] !== value) throw Error('NATIVE_PATCH_NOT_FROM_PINNED_SOURCE');
  }
  return plan;
}

module.exports = { VERSION, SOURCE_ACCOUNT, CLINICS, NATIVE_FIELDS, positiveId, blank, identityLinks, linkedClinicIds, nativePatch, buildArchivePlan, validatePlan };
