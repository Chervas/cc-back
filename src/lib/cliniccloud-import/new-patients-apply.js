'use strict';
const crypto = require('node:crypto');
const { hash, norm, dateOnly, localDateTime, localToUtc, normalizeContacts } = require('./adapter');
const { normalizeHumanName } = require('../name');
const VERSION = 'cliniccloud-new-patients/1';
const ACCOUNT = 'cliniccloud-5880';
const fail = code => { throw new Error(code); };
const digestBody = value => { const { package_sha256, ...body } = value; return hash(body); };
const nameKey = (first, last) => norm(`${first || ''} ${last || ''}`).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
const emailKey = value => String(value || '').trim().toLowerCase();
function phoneKey(value) {
  let valueDigits = String(value || '').replace(/\D/g, '');
  if (valueDigits.startsWith('00')) valueDigits = valueDigits.slice(2);
  if (valueDigits.length === 11 && valueDigits.startsWith('34')) valueDigits = valueDigits.slice(2);
  return valueDigits.length >= 7 && valueDigits.length <= 15 && !/^(\d)\1+$/.test(valueDigits) && !['123456789', '987654321', '0123456789'].includes(valueDigits) ? valueDigits : '';
}
function nationalKey(value) { const key = norm(value).replace(/[^\p{L}\p{N}]/gu, '').replace(/^ES(?=(?:\d{8}|[XYZ]\d{7})[A-Z]$)/, ''); return key.length >= 5 && !/^(\w)\1+$/.test(key) ? key : ''; }
function identityKeys(raw) {
  return { phones: [...new Set((raw.phones || []).map(phoneKey).filter(Boolean))], email: emailKey(raw.email), national_id: nationalKey(raw.national_id), name: nameKey(raw.name, raw.surname) };
}
function sourceIdentity(raw) { return identityKeys({ name: raw.NOMBRE, surname: raw.APELLIDOS, phones: [raw['TELF. MOVIL'], raw['TELF. FIJO'], raw['TELF. ADICIONAL']], email: raw.EMAIL, national_id: raw.DNI }); }
function localIdentity(raw) { return identityKeys({ name: raw.nombre, surname: raw.apellidos, phones: [raw.telefono_movil, raw.telefono_secundario], email: raw.email, national_id: raw.dni }); }
function intersects(a, b) {
  return a.phones.some(phone => b.phones.includes(phone)) || Boolean(a.email && a.email === b.email)
    || Boolean(a.national_id && a.national_id === b.national_id) || Boolean(a.name.split(' ').length > 1 && (a.name === b.name || a.name.replace(/ /g, '') === b.name.replace(/ /g, '')));
}
function sourceCreated(raw) {
  const match = /^(\d\d)-(\d\d)-(\d{4}) (\d\d:\d\d:\d\d)$/.exec(String(raw.ALTA || ''));
  const local = match && localDateTime(`${match[1]}/${match[2]}/${match[3]}`, match[4]);
  const utc = local && localToUtc(local);
  if (!utc || local.slice(0, 10) < '2026-08-01' || local.slice(0, 10) > '2026-09-05') fail('SOURCE_CREATION_NOT_WITHIN_CONFIRMED_COVERAGE');
  return { local, utc, raw: raw.ALTA };
}
function verifyAudit(audit, sources) {
  const { plan_sha256, ...body } = audit;
  if (hash(body) !== plan_sha256 || audit.manifest.version !== 'cliniccloud-new-patients-audit/1' || audit.manifest.source_account !== ACCOUNT
    || audit.manifest.policy.whatsapp_ignored !== true || audit.manifest.policy.primary_requires_source_creation_inside_export_coverage !== true) fail('NEW_PATIENT_AUDIT_INTEGRITY_MISMATCH');
  for (const file of audit.manifest.source_files) if (sources[file.role]?.file.sha256 !== file.sha256) fail('SOURCE_FILE_HASH_MISMATCH');
  const safe = audit.rows.filter(row => row.status === 'safe_candidate_for_reviewed_creation');
  if (!safe.length || safe.length > 70 || new Set(safe.map(row => row.source_contact_id)).size !== safe.length) fail('NEW_PATIENT_BATCH_SCOPE_INVALID');
  return safe;
}
function operationsFromAudit(audit, sources, { sourceIds = null } = {}) {
  const audited = verifyAudit(audit, sources);
  if (sourceIds && sourceIds.some(id => !audited.some(row => row.source_contact_id === id))) fail('REVIEWED_SOURCE_ID_OUTSIDE_AUDIT');
  const safe = sourceIds ? audited.filter(row => sourceIds.includes(row.source_contact_id)) : audited;
  const contacts = sources.contacts.rows.map(row => row.values), historic = sources.historic_contacts.rows.map(row => row.values);
  const allIdentities = contacts.map(raw => ({ id: raw.IDCONTACTO, keys: sourceIdentity(raw) }));
  const historicIdentities = historic.map(raw => ({ id: raw.idContacto, keys: identityKeys({ name: raw.nombre, surname: raw.apellidos, phones: [raw.tele1, raw.tele2], email: raw.email, national_id: raw.dni }) }));
  return safe.map(row => {
    const matches = sources.contacts.rows.filter(contact => contact.values.IDCONTACTO === row.source_contact_id);
    if (matches.length !== 1 || row.reasons.length || historic.some(contact => contact.idContacto === row.source_contact_id)) fail('SOURCE_ID_NOT_NEW_UNIQUE');
    const record = matches[0], raw = record.values, keys = sourceIdentity(raw), created = sourceCreated(raw);
    if (!/^[1-9]\d*$/.test(String(raw.NUM)) || String(raw.NUM) !== String(row.history_number)
      || contacts.some(other => other.IDCONTACTO !== raw.IDCONTACTO && String(other.NUM) === String(raw.NUM))
      || historic.some(other => String(other.num) === String(raw.NUM))) fail('HISTORY_NUMBER_NOT_NEW_UNIQUE');
    if (hash(raw) !== row.provenance.row_sha256 || record.source_row !== row.provenance.source_row || sources.contacts.file.sha256 !== row.provenance.file_sha256) fail('SOURCE_ROW_HASH_MISMATCH');
    if (norm(raw.ESTADO) !== 'ACTIVO' || /BLOQUEO AGENDA|VISITA COMERCIAL/.test(norm(`${raw.NOMBRE} ${raw.APELLIDOS}`))) fail('CONTACT_NOT_ACTIVE_PERSON');
    if (allIdentities.some(other => other.id !== row.source_contact_id && intersects(keys, other.keys)) || historicIdentities.some(other => intersects(keys, other.keys))) fail('SOURCE_OR_HISTORIC_IDENTITY_COLLISION');
    if (![66, 72].includes(row.proposed_primary_clinic_id) || !row.membership_clinic_ids.includes(row.proposed_primary_clinic_id)
      || row.membership_clinic_ids.some(id => ![66, 72].includes(id)) || !row.primary_evidence.length
      || !['oldest_paid_treatment', 'oldest_recorded_treatment'].includes(row.primary_rule)) fail('PRIMARY_CLINIC_EVIDENCE_REQUIRED');
    const normalized = normalizeContacts([record], sources.contacts.file.sha256)[0];
    if (hash(normalized.fields) !== hash(row.fields)) fail('AUDITED_CONTACT_FIELDS_CHANGED');
    if (String(raw['F. NACIMIENTO'] || '').trim() && !normalized.fields.birth_date) fail('SOURCE_BIRTH_DATE_INVALID');
    if (normalized.fields.birth_date && normalized.fields.birth_date > created.local.slice(0, 10)) fail('BIRTH_DATE_AFTER_SOURCE_CREATION');
    const payload = { nombre: normalizeHumanName(raw.NOMBRE), apellidos: normalizeHumanName(raw.APELLIDOS), dni: normalized.fields.national_id || null,
      telefono_movil: phoneKey(raw['TELF. MOVIL']) || null, telefono_secundario: phoneKey(raw['TELF. FIJO']) || phoneKey(raw['TELF. ADICIONAL']) || null,
      email: emailKey(raw.EMAIL) || null, fecha_nacimiento: normalized.fields.birth_date ? `${normalized.fields.birth_date}T00:00:00.000Z` : null,
      fecha_alta: created.utc, clinica_id: row.proposed_primary_clinic_id, idioma_preferido: 'es', paciente_conocido: true };
    if (!payload.nombre || !payload.apellidos || Object.values(payload).some(value => typeof value === 'string' && (value.length > 255 || /[\u0000-\u001f]/.test(value)))) fail('PATIENT_DEMOGRAPHICS_INVALID');
    if (!payload.telefono_movil && !payload.telefono_secundario && !payload.email) fail('CONTACT_CHANNEL_OR_GUARDIAN_REQUIRED');
    const value = { action_key: row.action_key, source_contact_id: row.source_contact_id, history_number: row.history_number, provenance: row.provenance,
      identity: keys, source_fields: normalized.fields, payload, memberships: [...new Set(row.membership_clinic_ids)].sort((a, b) => a - b), source_created: created,
      primary_rule: row.primary_rule, primary_evidence: row.primary_evidence };
    return { ...value, operation_sha256: hash(value) };
  }).sort((a, b) => a.source_contact_id.localeCompare(b.source_contact_id));
}
function sourceMatches(live, sourceId) {
  return [...new Set(live.source_links.filter(link => String(link.source_contact_id) === String(sourceId)).map(link => Number(link.paciente_id)))];
}
function historyMatches(live, historyNumber) {
  return [...new Set(live.source_links.filter(link => link.history_number != null && String(link.history_number) === String(historyNumber)).map(link => Number(link.paciente_id)))];
}
function collisions(operation, live, ignoredIds = []) {
  const ignored = new Set(ignoredIds.map(Number));
  return live.patients.filter(row => !ignored.has(Number(row.id_paciente)) && intersects(operation.identity, localIdentity(row))).map(row => Number(row.id_paciente));
}
function globalGuard(live, excludeIds = []) {
  const ignored = new Set(excludeIds.map(Number));
  return hash({ clinic_ids: [...live.clinic_ids].sort((a, b) => a - b), group_id: live.group_id,
    patients: live.patients.filter(row => !ignored.has(Number(row.id_paciente))).sort((a, b) => a.id_paciente - b.id_paciente),
    source_links: live.source_links.filter(row => !ignored.has(Number(row.paciente_id))).sort((a, b) => `${a.paciente_id}:${a.source_contact_id}`.localeCompare(`${b.paciente_id}:${b.source_contact_id}`)) });
}
function reviewedSourceIds(audit, sources, review) {
  const audited = verifyAudit(audit, sources);
  if (!review || review.source_audit_sha256 !== audit.plan_sha256 || !String(review.prepared_by || '').trim() || !Array.isArray(review.decisions)
    || review.decisions.length !== audited.length || new Set(review.decisions.map(row => row.source_contact_id)).size !== audited.length
    || review.decisions.some(row => !audited.some(operation => operation.source_contact_id === row.source_contact_id) || !['retain', 'defer'].includes(row.disposition) || !String(row.reason || '').trim())) fail('COMPLETE_IDENTITY_REVIEW_REQUIRED');
  return review.decisions.filter(row => row.disposition === 'retain').map(row => row.source_contact_id);
}
function prepareNewPatients({ audit, sources, review, live, now = new Date().toISOString() }) {
  const sourceIds = reviewedSourceIds(audit, sources, review);
  const excluded = review.decisions.filter(row => row.disposition === 'defer');
  const operations = operationsFromAudit(audit, sources, { sourceIds });
  if (!operations.length) fail('NO_REVIEWED_CREATIONS_REMAIN');
  for (const operation of operations) {
    if (sourceMatches(live, operation.source_contact_id).length) fail('NEW_PATIENT_SOURCE_NOW_EXISTS');
    if (historyMatches(live, operation.history_number).length) fail('NEW_PATIENT_HISTORY_NUMBER_NOW_EXISTS');
    if (collisions(operation, live).length) fail('NEW_PATIENT_LOCAL_IDENTITY_COLLISION');
  }
  const value = { version: VERSION, source_account: ACCOUNT, source_audit_sha256: audit.plan_sha256, source_files: audit.manifest.source_files,
    generated_at: now, group_id: live.group_id, clinic_ids: live.clinic_ids, automation_policy: 'hold', messages_enabled: false, appointments_created: false,
    native_create_uniqueness_guaranteed: false, expected_global_guard: globalGuard(live), identity_review_sha256: hash(review), excluded, operations };
  return { ...value, package_sha256: hash(value) };
}
function verifyPackage(pkg) {
  if (pkg.version !== VERSION || digestBody(pkg) !== pkg.package_sha256 || pkg.source_account !== ACCOUNT || pkg.automation_policy !== 'hold'
    || pkg.messages_enabled !== false || pkg.native_create_uniqueness_guaranteed !== false || !pkg.operations.length || pkg.operations.length > 70) fail('NEW_PATIENT_PACKAGE_INTEGRITY_MISMATCH');
  if (new Set(pkg.operations.map(row => row.source_contact_id)).size !== pkg.operations.length) fail('DUPLICATE_SOURCE_OPERATION');
  for (const operation of pkg.operations) {
    const { operation_sha256, ...body } = operation;
    if (hash(body) !== operation_sha256) fail('NEW_PATIENT_OPERATION_INTEGRITY_MISMATCH');
  }
}
async function executeNewPatients({ pkg, approval, store, journal, now = () => Date.now(), publicId = () => `pac_${crypto.randomBytes(10).toString('hex')}` }) {
  verifyPackage(pkg);
  if (approval.package_sha256 !== pkg.package_sha256 || !String(approval.reviewed_by || '').trim() || approval.acknowledge_native_create_race !== true
    || approval.automation_policy !== 'hold' || !/^[a-f0-9]{64}$/.test(approval.backup_manifest_sha256 || '') || !/T.*Z$/.test(approval.expires_at || '')
    || !Number.isFinite(Date.parse(approval.expires_at)) || Date.parse(approval.expires_at) <= now()) fail('NEW_PATIENT_EXPLICIT_APPROVAL_REQUIRED');
  const created = [], preserved = [];
  await store.transaction(async tx => {
    const before = await tx.captureGroup();
    if (before.group_id !== pkg.group_id || hash([...before.clinic_ids].sort()) !== hash([...pkg.clinic_ids].sort())) fail('NEW_PATIENT_GROUP_SCOPE_CHANGED');
    for (const operation of pkg.operations) {
      const linked = sourceMatches(before, operation.source_contact_id);
      if (linked.length > 1) fail('NEW_PATIENT_SOURCE_LINK_AMBIGUOUS');
      if (linked.length === 1) { preserved.push({ source_contact_id: operation.source_contact_id, patient_id: linked[0], operation_sha256: operation.operation_sha256 }); continue; }
      if (historyMatches(before, operation.history_number).length) fail('NEW_PATIENT_HISTORY_NUMBER_NOW_EXISTS');
      if (collisions(operation, before).length) fail('NEW_PATIENT_LOCAL_IDENTITY_COLLISION');
    }
    const remaining = pkg.operations.filter(operation => !preserved.some(row => row.source_contact_id === operation.source_contact_id));
    const baselineGuard = globalGuard(before);
    // One atomic batch cannot normally leave a partial replay. Never guess
    // whether an existing identity belongs to a previous successful attempt.
    if (preserved.length && remaining.length) fail('PARTIAL_SOURCE_REPLAY_REQUIRES_REVIEW');
    if (remaining.length && baselineGuard !== pkg.expected_global_guard) fail('PREPARED_GLOBAL_IDENTITY_SNAPSHOT_CHANGED');
    await journal.append({ phase: 'prepared_new_patients', package_sha256: pkg.package_sha256, before_global_guard: baselineGuard,
      operations: remaining, preserved, reviewed_by: approval.reviewed_by, backup_manifest_sha256: approval.backup_manifest_sha256 });
    for (const operation of remaining) {
      const payload = { ...operation.payload, public_id: publicId() };
      const result = await tx.insertPatient(operation, payload, { package_sha256: pkg.package_sha256, reviewed_by: approval.reviewed_by, imported_at: new Date(now()).toISOString(), source_account: ACCOUNT });
      created.push({ action_key: operation.action_key, source_contact_id: operation.source_contact_id, patient_id: Number(result.patient_id), public_id: payload.public_id,
        operation_sha256: operation.operation_sha256, after_sha256: result.after_sha256 });
    }
    const fresh = await tx.captureGroup(); // READ COMMITTED: a new read, not the initial snapshot.
    if (globalGuard(fresh, created.map(row => row.patient_id)) !== baselineGuard) fail('CONCURRENT_NATIVE_PATIENT_OR_IDENTITY_CHANGE');
    for (const operation of pkg.operations) {
      const ids = sourceMatches(fresh, operation.source_contact_id);
      if (ids.length !== 1) fail('NEW_PATIENT_DURABLE_IDENTITY_VERIFICATION_FAILED');
      const ownCreated = created.find(row => row.source_contact_id === operation.source_contact_id);
      if (ownCreated && (ids[0] !== ownCreated.patient_id || collisions(operation, fresh, [ownCreated.patient_id]).length)) fail('NEW_PATIENT_PRECOMMIT_COLLISION');
      if (ownCreated && historyMatches(fresh, operation.history_number).some(id => id !== ownCreated.patient_id)) fail('NEW_PATIENT_PRECOMMIT_HISTORY_COLLISION');
    }
    if (Date.parse(approval.expires_at) <= now()) fail('NEW_PATIENT_APPROVAL_EXPIRED_BEFORE_COMMIT');
    await journal.append({ phase: 'validated_before_commit', package_sha256: pkg.package_sha256, created, preserved, after_global_guard: globalGuard(fresh) });
  });
  await journal.append({ phase: 'committed_new_patients', package_sha256: pkg.package_sha256, created, preserved });
  const after = await store.captureGroup();
  const postConflicts = [];
  for (const entry of created) {
    const operation = pkg.operations.find(row => row.source_contact_id === entry.source_contact_id);
    const linked = sourceMatches(after, entry.source_contact_id);
    if (linked.length !== 1 || linked[0] !== entry.patient_id || historyMatches(after, operation.history_number).some(id => id !== entry.patient_id) || collisions(operation, after, [entry.patient_id]).length) postConflicts.push({ source_contact_id: entry.source_contact_id, patient_id: entry.patient_id });
  }
  await journal.append({ phase: 'post_commit_audit', package_sha256: pkg.package_sha256, conflicts: postConflicts, native_create_uniqueness_guaranteed: false });
  if (postConflicts.length) fail('COMMITTED_PATIENT_IDENTITY_COLLISION_STOP_ALL_BATCHES');
  return { created_patients: created.length, preserved_existing_source_patients: preserved.length, appointments_created: 0, messages_enabled: false, consent_mutations: 0, post_commit_collisions: 0, native_create_uniqueness_guaranteed: false, package_sha256: pkg.package_sha256 };
}
module.exports = { VERSION, ACCOUNT, identityKeys, sourceIdentity, localIdentity, intersects, sourceCreated, phoneKey, nationalKey, nameKey, sourceMatches, historyMatches, collisions, globalGuard, verifyAudit, reviewedSourceIds, operationsFromAudit, prepareNewPatients, verifyPackage, executeNewPatients };
