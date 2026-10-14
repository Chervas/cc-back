'use strict';

// Pure administrative plan: only empty canonical address cells may change.
// Source records, identities, memberships and every other patient field remain
// evidence, never write targets. A source address is selected as one tuple.
const { hash, stableJson, dateOnly } = require('./adapter');
const { PATIENT_PROFILE_FIELD_SPECS } = require('../patient-profile-fields');

const VERSION = 'cliniccloud-address-backfill/1';
const SOURCE_ACCOUNT = 'cliniccloud-5880';
const CLINICS = Object.freeze([66, 72]);
const ADDRESS_FIELDS = Object.freeze(['direccion', 'codigo_postal', 'poblacion', 'provincia', 'pais']);
const ADDRESS_COLUMNS = Object.freeze({
  direccion: ['domicilio', 'DOMICILIO'],
  codigo_postal: ['cp', 'CP'],
  poblacion: ['pobla', 'poblacion', 'POBLACION', 'POBLACIÓN'],
  provincia: ['provi', 'PROVINCIA'],
  pais: ['pais', 'PAIS'],
});
const CONTACT_ID_COLUMNS = ['idContacto', 'idcontacto', 'IDCONTACTO'];
const HISTORY_COLUMNS = ['num', 'NUM'];
const IDENTITY_LINK_FIELDS = ['id', 'paciente_id', 'clinica_id', 'source_column', 'field_key', 'last_imported_at', 'sha256', 'source_contact_id'];
const HASH = /^[a-f0-9]{64}$/;
const PLACEHOLDERS = new Set(['-', '--', '---', 'NULL', 'NONE', 'UNDEFINED', 'N/A', 'N/D', 'S/D']);

function fail(code) { throw new Error(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date); }
function blank(value) { return value == null || (typeof value === 'string' && !value.trim()); }
function positiveId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0 ? Number(text) : null;
}
function equivalent(value) { return String(value).normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleUpperCase('es'); }
function instant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value)) return null;
  const day = value.slice(0, 10);
  const clock = value.slice(11, 19).split(':').map(Number);
  const normalized = value.replace(' ', 'T') + (/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? '' : 'Z');
  return dateOnly(day) === day && clock[0] < 24 && clock[1] < 60 && clock[2] < 60 && Number.isFinite(Date.parse(normalized)) ? value : null;
}
function normalizedText(value, field) {
  if (blank(value)) return { value: '' };
  if (typeof value !== 'string') return { error: true };
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (PLACEHOLDERS.has(equivalent(normalized))) return { value: '' };
  if (field === 'pais' && /^[+-]?\d+(?:[.,]\d+)?$/.test(normalized)) return { error: true };
  const maximum = PATIENT_PROFILE_FIELD_SPECS[field].maxLength;
  if (/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
    || Array.from(normalized).length > maximum || Buffer.byteLength(normalized, 'utf8') > 65535) return { error: true };
  return { value: normalized };
}
function aliasId(contact, columns) {
  const values = columns.filter(key => Object.hasOwn(contact, key)).map(key => positiveId(contact[key]));
  if (!values.length || values.some(value => !value) || new Set(values).size !== 1) return null;
  return values[0];
}
function aliasText(contact, field) {
  const values = ADDRESS_COLUMNS[field].filter(key => Object.hasOwn(contact, key)).map(key => normalizedText(contact[key], field));
  if (values.some(value => value.error)) return { error: true };
  const nonempty = values.filter(value => value.value);
  if (new Set(nonempty.map(value => equivalent(value.value))).size > 1) return { error: true };
  return { value: nonempty[0]?.value || '' };
}
function countryCatalog(countries) {
  if (countries == null) return null;
  if (object(countries) && object(countries.values) && !Object.keys(countries.values).length && countries.provenance == null) return null;
  const proof = countries.provenance;
  if (!object(countries) || !object(countries.values) || !object(proof)
    || typeof proof.file !== 'string' || !proof.file.trim() || /[\u0000-\u001f]/.test(proof.file)
    || !HASH.test(proof.sha256 || '')) fail('COUNTRY_MAPPING_PROOF_INVALID');
  const values = {};
  for (const [key, value] of Object.entries(countries.values)) {
    const id = positiveId(key), text = normalizedText(value, 'pais');
    if (!id || text.error || !text.value || Object.hasOwn(values, id)) fail('COUNTRY_MAPPING_VALUES_INVALID');
    values[id] = text.value;
  }
  return { values, provenance: { file: proof.file, sha256: proof.sha256 } };
}
function addressOf(contact, countries) {
  const address = {}, errors = [];
  for (const field of ADDRESS_FIELDS) {
    const result = aliasText(contact, field);
    if (result.error) errors.push(field);
    address[field] = result.value || '';
  }
  let countryMapping = null;
  if (!address.pais && !errors.includes('pais') && Object.hasOwn(contact, 'idPais') && !blank(contact.idPais)) {
    const countryId = positiveId(contact.idPais), emptyId = ['0', '-1'].includes(String(contact.idPais).trim());
    if (!countryId && !emptyId) errors.push('pais');
    else if (countries && Object.hasOwn(countries.values, countryId)) {
      address.pais = countries.values[countryId];
      countryMapping = { id: countryId, ...countries.provenance };
    }
  }
  const explicit = Object.values(ADDRESS_COLUMNS).flat().some(key => Object.hasOwn(contact, key)) || Object.hasOwn(contact, 'idPais');
  return { address, errors, explicit, countryMapping };
}
function sourceKind(column) {
  if (column === 'contacto_1.csv') return 'historical';
  if (column === 'cliniccloud_contact_snapshot') return 'snapshot';
  return typeof column === 'string' && /^BACKUP_CONTACTOS_\d{4}-\d{2}-\d{2}\.csv$/.test(column) ? 'export' : null;
}
function linkedClinics(patient) {
  const memberships = Array.isArray(patient.memberships) ? patient.memberships : [];
  return new Set([positiveId(patient.clinica_id), ...memberships.filter(row => object(row)
    && (row.paciente_id == null || positiveId(row.paciente_id) === positiveId(patient.id_paciente)))
    .map(row => positiveId(row.clinica_id))].filter(Boolean));
}
function sourceMetadata(source, generatedDay) {
  const kind = sourceKind(source.source_column), reasons = [];
  if (!kind) return null;
  if (!positiveId(source.id) || !HASH.test(source.sha256 || '')) reasons.push('SOURCE_FINGERPRINT_INVALID');
  if (!CLINICS.includes(positiveId(source.clinica_id))) reasons.push('SOURCE_SCOPE_MISMATCH');
  if ((kind === 'snapshot' && source.record_version !== 'cliniccloud_contact_snapshot/1')
    || (kind === 'export' && source.record_version !== 'cliniccloud_patient_history/1')
    || (kind !== 'historical' && source.source_account !== SOURCE_ACCOUNT)
    || (source.source_account != null && source.source_account !== SOURCE_ACCOUNT)) reasons.push('SOURCE_VERSION_OR_ACCOUNT_INVALID');
  let sourceDate = null;
  if (!blank(source.source_date)) {
    sourceDate = typeof source.source_date === 'string' && dateOnly(source.source_date) === source.source_date ? source.source_date : null;
    if (!sourceDate) reasons.push('SOURCE_DATE_INVALID');
  }
  if (kind === 'export' && (!sourceDate || source.source_column !== `BACKUP_CONTACTOS_${sourceDate}.csv`)) reasons.push('SOURCE_DATE_INVALID');
  const importedAt = blank(source.last_imported_at) ? null : instant(source.last_imported_at);
  if (!blank(source.last_imported_at) && !importedAt) reasons.push('SOURCE_TIMESTAMP_INVALID');
  const effectiveDate = sourceDate || (kind === 'export' ? null : importedAt?.slice(0, 10)) || '';
  if (effectiveDate > generatedDay) reasons.push('SOURCE_DATE_INVALID');
  return { kind, sourceDate, effectiveDate, importedAt, reasons };
}
function provenanceSource(source, metadata) {
  return {
    id: positiveId(source.id), source_column: source.source_column, field_key: source.field_key ?? null,
    clinica_id: positiveId(source.clinica_id), last_imported_at: metadata.importedAt, sha256: source.sha256,
    record_version: source.record_version ?? null, source_account: source.source_account ?? null,
    source_company_id: metadata.kind === 'historical' ? positiveId(source.contact?.idEmpresa) : null,
    source_date: metadata.sourceDate,
  };
}
function planHash(plan) { const { plan_sha256, ...body } = plan; return hash(body); }
function identityLinksHash(links) {
  if (!Array.isArray(links) || links.some(link => !object(link))) fail('IDENTITY_LINKS_INPUT_INVALID');
  const proofs = links.map(link => Object.fromEntries(IDENTITY_LINK_FIELDS.map(field => [field,
    link[field] instanceof Date ? instant(link[field]) : link[field] ?? null])));
  proofs.sort((a, b) => { const left = stableJson(a), right = stableJson(b); return left < right ? -1 : left > right ? 1 : 0; });
  return hash(proofs);
}
function identityLinkKeyValid(link, contactId) {
  if (link.source_column !== 'idContacto' || !contactId) return false;
  if (link.field_key === 'cliniccloud_source_contact_id') return true;
  const marker = /^cliniccloud_source_contact_id[:_]([1-9]\d*)$/.exec(link.field_key || '');
  const alias = /^cliniccloud_contact_alias_([1-9]\d*)$/.exec(link.field_key || '');
  return positiveId((marker || alias)?.[1]) === contactId;
}

function buildAddressBackfillPlan({ target, patients, sources, countries, scope, generatedAt, identityLinks } = {}) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.map(positiveId).sort((a, b) => a - b) : [];
  if (!['dev', 'crm'].includes(target)) fail('ADDRESS_TARGET_INVALID');
  if (stableJson(clinicIds) !== stableJson(CLINICS) || positiveId(scope?.groupId) !== 29) fail('ADDRESS_SCOPE_INVALID');
  const generated = instant(generatedAt);
  if (!generated) fail('EXPLICIT_GENERATED_AT_REQUIRED');
  if (!Array.isArray(patients) || !Array.isArray(sources)) fail('ADDRESS_INPUT_ARRAYS_REQUIRED');
  const identityProof = identityLinks === undefined ? null : identityLinksHash(identityLinks);
  const countriesById = countryCatalog(countries);
  const byPatient = new Map(), reviewReasons = new Map(), contactOwners = new Map(), historyOwners = new Map(), eligible = new Map();
  const identityIdsByPatient = new Map(), identityRowCounts = new Map();
  const addReason = (id, reason) => {
    if (!reviewReasons.has(id)) reviewReasons.set(id, new Set());
    reviewReasons.get(id).add(reason);
  };
  const addOwner = (index, key, owner) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(owner);
  };
  for (const patient of patients) {
    const id = object(patient) && positiveId(patient.id_paciente);
    if (!id) fail('PATIENT_ID_INVALID');
    if (byPatient.has(id)) fail('DUPLICATE_PATIENT_ID');
    byPatient.set(id, patient);
    addOwner(historyOwners, positiveId(patient.numero_historia), id);
  }
  for (const link of identityLinks || []) {
    const rowId = positiveId(link.id);
    if (rowId) identityRowCounts.set(rowId, (identityRowCounts.get(rowId) || 0) + 1);
  }
  for (const link of identityLinks || []) {
    const id = positiveId(link.paciente_id), contactId = positiveId(link.source_contact_id), clinic = positiveId(link.clinica_id);
    // All captured owners matter, including patients and clinics outside the
    // authorized write scope. Their evidence cannot authorize an address write.
    addOwner(contactOwners, contactId, id);
    if (contactId) {
      if (!identityIdsByPatient.has(id)) identityIdsByPatient.set(id, new Set());
      identityIdsByPatient.get(id).add(contactId);
    }
    const patient = byPatient.get(id);
    if (!patient) continue;
    const linked = linkedClinics(patient);
    if (![...linked].some(value => CLINICS.includes(value))) continue;
    const importedAt = blank(link.last_imported_at) ? null : instant(link.last_imported_at);
    if (!positiveId(link.id) || identityRowCounts.get(positiveId(link.id)) !== 1 || !id || !CLINICS.includes(clinic) || !contactId
      || !HASH.test(link.sha256 || '') || !identityLinkKeyValid(link, contactId)
      || (!blank(link.last_imported_at) && !importedAt)
      || (importedAt && importedAt.slice(0, 10) > generated.slice(0, 10))
      || !linked.has(clinic)) addReason(id, 'IDENTITY_LINK_INVALID');
  }
  const recognized = sources.filter(source => object(source) && sourceKind(source.source_column));
  const sourceIds = new Map();
  for (const source of recognized) {
    const id = positiveId(source.paciente_id), sourceId = positiveId(source.id);
    const contact = object(source.contact) ? source.contact : null;
    if (contact) addOwner(contactOwners, aliasId(contact, CONTACT_ID_COLUMNS), id);
    if (sourceId) {
      if (!sourceIds.has(sourceId)) sourceIds.set(sourceId, []);
      sourceIds.get(sourceId).push(source);
    }
  }
  for (const source of recognized) {
    const id = positiveId(source.paciente_id), patient = byPatient.get(id);
    // Capture includes source owners beyond the scope for ambiguity checks, but
    // the plan only names patients supplied for the authorized clinical scope.
    if (!patient) continue;
    const linked = linkedClinics(patient);
    if (![...linked].some(clinic => CLINICS.includes(clinic))) continue;
    if (!eligible.has(id)) eligible.set(id, []);
    const metadata = sourceMetadata(source, generated.slice(0, 10));
    for (const reason of metadata.reasons) addReason(id, reason);
    if (!linked.has(positiveId(source.clinica_id))) addReason(id, 'SOURCE_CLINIC_NOT_LINKED');
    const siblings = sourceIds.get(positiveId(source.id)) || [];
    if (siblings.some(row => row.sha256 !== source.sha256 || positiveId(row.paciente_id) !== id)) addReason(id, 'SOURCE_FINGERPRINT_CONFLICT');
    if (!object(source.contact)) { addReason(id, 'SOURCE_CONTACT_INVALID'); continue; }
    if (metadata.kind === 'historical' && positiveId(source.contact.idEmpresa) !== 5880) addReason(id, 'SOURCE_VERSION_OR_ACCOUNT_INVALID');
    const contactId = aliasId(source.contact, CONTACT_ID_COLUMNS), history = aliasId(source.contact, HISTORY_COLUMNS);
    if (!contactId) addReason(id, 'SOURCE_CONTACT_ID_INVALID');
    if (metadata.kind === 'historical' && source.field_key !== `cliniccloud_raw_contact:${contactId}`) addReason(id, 'SOURCE_FIELD_KEY_MISMATCH');
    if (metadata.kind === 'snapshot' && source.field_key !== 'cliniccloud_contact_snapshot') addReason(id, 'SOURCE_FIELD_KEY_MISMATCH');
    if (metadata.kind === 'export' && source.field_key !== `cliniccloud_history_contact_${(metadata.sourceDate || '').replaceAll('-', '')}_${contactId}`) addReason(id, 'SOURCE_FIELD_KEY_MISMATCH');
    if (!history || !positiveId(patient.numero_historia) || history !== positiveId(patient.numero_historia)) addReason(id, 'SOURCE_HISTORY_MISMATCH');
    if (contactId && (contactOwners.get(contactId)?.size !== 1 || !contactOwners.get(contactId)?.has(id))) addReason(id, 'AMBIGUOUS_SOURCE_CONTACT_ID');
    if (history && (historyOwners.get(history)?.size !== 1 || !historyOwners.get(history)?.has(id))) addReason(id, 'AMBIGUOUS_HISTORY_NUMBER');
    const address = addressOf(source.contact, countriesById);
    if (address.errors.length) addReason(id, 'INVALID_SOURCE_ADDRESS');
    eligible.get(id).push({ source, metadata, contactId, history, ...address });
  }
  const operations = [], fieldsUpdated = Object.fromEntries(ADDRESS_FIELDS.map(field => [field, 0]));
  let patientsInScope = 0, patientsUnchanged = 0;
  for (const [id, patient] of [...byPatient.entries()].sort((a, b) => a[0] - b[0])) {
    const linked = linkedClinics(patient);
    if (![...linked].some(clinic => CLINICS.includes(clinic))) continue;
    patientsInScope++;
    const candidates = eligible.get(id) || [];
    const contactIds = new Set(candidates.map(candidate => candidate.contactId).filter(Boolean));
    const linkedIds = identityIdsByPatient.get(id) || new Set();
    if (linkedIds.size > 1 || (linkedIds.size && new Set([...linkedIds, ...contactIds]).size > 1)) addReason(id, 'IDENTITY_LINK_CONFLICT');
    if (!candidates.length) { if (!reviewReasons.has(id)) patientsUnchanged++; continue; }
    if (contactIds.size > 1) addReason(id, 'AMBIGUOUS_SOURCE_CONTACT_ID');
    if (!positiveId(patient.clinica_id)) addReason(id, 'PATIENT_CLINIC_INVALID');
    const updatedAt = instant(patient.updatedAt);
    if (!updatedAt) addReason(id, 'PATIENT_TIMESTAMP_INVALID');
    if (ADDRESS_FIELDS.some(field => patient[field] != null && typeof patient[field] !== 'string')) addReason(id, 'CANONICAL_ADDRESS_INVALID');
    if (reviewReasons.has(id)) continue;
    const addresses = candidates.filter(candidate => candidate.explicit);
    if (!addresses.length) { patientsUnchanged++; continue; }
    const latestDate = addresses.reduce((latest, candidate) => candidate.metadata.effectiveDate > latest ? candidate.metadata.effectiveDate : latest, '');
    const latest = addresses.filter(candidate => candidate.metadata.effectiveDate === latestDate)
      .sort((a, b) => positiveId(a.source.id) - positiveId(b.source.id));
    const tuples = new Set(latest.map(candidate => stableJson(ADDRESS_FIELDS.map(field => equivalent(candidate.address[field])))));
    if (tuples.size !== 1) { addReason(id, 'LATEST_ADDRESS_CONFLICT'); continue; }
    const selected = latest[0];
    if (ADDRESS_FIELDS.some(field => !blank(patient[field]) && selected.address[field]
      && equivalent(patient[field]) !== equivalent(selected.address[field]))) { addReason(id, 'CANONICAL_ADDRESS_CONFLICT'); continue; }
    const updates = {};
    for (const field of ADDRESS_FIELDS) if (blank(patient[field]) && selected.address[field]) updates[field] = selected.address[field];
    if (!Object.keys(updates).length) { patientsUnchanged++; continue; }
    const pinned = [...new Map(latest.map(candidate => [positiveId(candidate.source.id), candidate])).values()];
    operations.push({
      patient_id: id, history_number: patient.numero_historia,
      expected: { clinica_id: positiveId(patient.clinica_id), updatedAt, address: Object.fromEntries(ADDRESS_FIELDS.map(field => [field, patient[field] ?? null])) },
      updates,
      source_fingerprints: pinned.map(candidate => ({ id: positiveId(candidate.source.id), sha256: candidate.source.sha256 })),
      provenance: {
        source_account: SOURCE_ACCOUNT, source_contact_id: selected.contactId, source_date: selected.metadata.sourceDate,
        effective_source_date: latestDate || null, sources: pinned.map(candidate => provenanceSource(candidate.source, candidate.metadata)),
        ...(selected.countryMapping ? { country_mapping: selected.countryMapping } : {}),
      },
    });
    for (const field of Object.keys(updates)) fieldsUpdated[field]++;
  }
  const reviews = [...reviewReasons.entries()].sort((a, b) => a[0] - b[0])
    .map(([patient_id, reasons]) => ({ patient_id, reasons: [...reasons].sort() }));
  const body = {
    version: VERSION, scope: { clinicIds: [...CLINICS], groupId: 29 }, target, generated_at: generated,
    ...(identityProof === null ? {} : { identity_links_sha256: identityProof }),
    operations, reviews,
    summary: {
      patients_total: patients.length, patients_in_scope: patientsInScope, patients_with_sources: eligible.size,
      patients_updated: operations.length, fields_updated: Object.values(fieldsUpdated).reduce((total, count) => total + count, 0),
      patients_review: reviews.length, patients_unchanged: patientsUnchanged, fields_updated_by_name: fieldsUpdated,
    },
  };
  return { ...body, plan_sha256: hash(body) };
}

function validateAddressBackfillPlan(plan) {
  if (!object(plan) || plan.version !== VERSION || !HASH.test(plan.plan_sha256 || '') || planHash(plan) !== plan.plan_sha256) fail('ADDRESS_PLAN_PROOF_INVALID');
  if (Object.hasOwn(plan, 'identity_links_sha256') && !HASH.test(plan.identity_links_sha256 || '')) fail('IDENTITY_LINKS_PROOF_INVALID');
  if (!['dev', 'crm'].includes(plan.target) || stableJson(plan.scope) !== stableJson({ clinicIds: [...CLINICS], groupId: 29 }) || !instant(plan.generated_at)) fail('ADDRESS_PLAN_SCOPE_INVALID');
  if (!Array.isArray(plan.operations) || !Array.isArray(plan.reviews)) fail('ADDRESS_PLAN_OPERATIONS_INVALID');
  if (plan.reviews.some(review => !object(review) || !positiveId(review.patient_id) || !Array.isArray(review.reasons)
    || !review.reasons.length || review.reasons.some(reason => typeof reason !== 'string' || !/^[A-Z_]+$/.test(reason)))) fail('ADDRESS_PLAN_REVIEWS_INVALID');
  const seen = new Set(), reviewed = new Set(plan.reviews.map(review => positiveId(review.patient_id)));
  for (const operation of plan.operations) {
    const id = positiveId(operation?.patient_id), expected = operation?.expected, provenance = operation?.provenance;
    if (!id || seen.has(id) || reviewed.has(id) || !positiveId(operation.history_number)
      || !object(expected) || !positiveId(expected.clinica_id) || !instant(expected.updatedAt)
      || !object(expected.address) || stableJson(Object.keys(expected.address).sort()) !== stableJson([...ADDRESS_FIELDS].sort())
      || ADDRESS_FIELDS.some(field => expected.address[field] !== null && typeof expected.address[field] !== 'string')
      || !object(operation.updates) || !Object.keys(operation.updates).length
      || !object(provenance) || provenance.source_account !== SOURCE_ACCOUNT || !positiveId(provenance.source_contact_id)
      || !Array.isArray(operation.source_fingerprints) || !operation.source_fingerprints.length
      || operation.source_fingerprints.some(row => !positiveId(row.id) || !HASH.test(row.sha256 || ''))
      || new Set(operation.source_fingerprints.map(row => positiveId(row.id))).size !== operation.source_fingerprints.length) fail('ADDRESS_OPERATION_INVALID');
    if (!Array.isArray(provenance.sources) || provenance.sources.length !== operation.source_fingerprints.length
      || stableJson(provenance.sources.map(row => ({ id: row.id, sha256: row.sha256 })).sort((a, b) => a.id - b.id))
        !== stableJson([...operation.source_fingerprints].sort((a, b) => a.id - b.id))) fail('ADDRESS_SOURCE_PROOF_INVALID');
    for (const source of provenance.sources) {
      const metadata = object(source) && sourceMetadata(source, plan.generated_at.slice(0, 10));
      if (!metadata || metadata.reasons.length || !CLINICS.includes(positiveId(source.clinica_id))
        || (metadata.kind === 'historical' && source.source_company_id !== 5880)
        || (metadata.kind === 'historical' && source.field_key !== `cliniccloud_raw_contact:${provenance.source_contact_id}`)
        || (metadata.kind === 'snapshot' && source.field_key !== 'cliniccloud_contact_snapshot')
        || (metadata.kind === 'export' && source.field_key !== `cliniccloud_history_contact_${(metadata.sourceDate || '').replaceAll('-', '')}_${provenance.source_contact_id}`)) fail('ADDRESS_SOURCE_PROOF_INVALID');
    }
    if (provenance.country_mapping) {
      const proof = provenance.country_mapping;
      if (!object(proof) || !positiveId(proof.id) || typeof proof.file !== 'string' || !proof.file.trim() || !HASH.test(proof.sha256 || '')) fail('COUNTRY_MAPPING_PROOF_INVALID');
    }
    seen.add(id);
    for (const [field, value] of Object.entries(operation.updates)) {
      if (!ADDRESS_FIELDS.includes(field) || !blank(expected.address[field])) fail('ADDRESS_UPDATE_OUTSIDE_ALLOWLIST');
      const text = normalizedText(value, field);
      if (text.error || !text.value || text.value !== value) fail('ADDRESS_UPDATE_INVALID');
    }
  }
  return plan;
}

module.exports = { VERSION, SOURCE_ACCOUNT, CLINICS, ADDRESS_FIELDS, ADDRESS_COLUMNS, blank, positiveId, planHash, identityLinksHash, buildAddressBackfillPlan, validateAddressBackfillPlan };
