'use strict';

// Operator SQL only. This module does not load models, HTTP handlers, workers,
// automation hooks or clinical records. The five address columns are the only
// write targets; all source archives and memberships remain read-only evidence.
const { hash, stableJson } = require('./adapter');
const { ADDRESS_FIELDS, CLINICS, buildAddressBackfillPlan, validateAddressBackfillPlan } = require('./address-backfill');

const CONTACT_KEYS = Object.freeze(['idContacto', 'idcontacto', 'IDCONTACTO', 'idEmpresa', 'num', 'NUM',
  'domicilio', 'DOMICILIO', 'cp', 'CP', 'pobla', 'poblacion', 'POBLACION', 'POBLACIÓN',
  'provi', 'PROVINCIA', 'pais', 'PAIS', 'idPais']);
const SCOPE = Object.freeze({ clinicIds: [...CLINICS], groupId: 29 });
const PATIENT_COLUMNS = ['id_paciente', 'numero_historia', 'clinica_id', 'updatedAt', ...ADDRESS_FIELDS];
const SAFE_JSON = "CASE WHEN JSON_VALID(value) THEN value ELSE '{}' END";
// Include known account-5880 owners outside the two clinics as ambiguity
// evidence, never as write targets. Do not mix other ClinicCloud accounts.
const SOURCE_FILTER = `source='cliniccloud' AND (clinica_id IN (66,72) OR JSON_UNQUOTE(JSON_EXTRACT(${SAFE_JSON},'$.source_account'))='cliniccloud-5880') AND (source_column IN ('contacto_1.csv','cliniccloud_contact_snapshot') OR source_column LIKE 'BACKUP_CONTACTOS_%')`;
const assert = (condition, code) => { if (!condition) throw Error(code); };
const decode = value => typeof value === 'string' ? JSON.parse(value) : value;

async function preflightAddressDatabase(connection) {
  const [identity] = await connection.query('SELECT DATABASE() AS database_name, @@server_uuid AS server_uuid');
  const [clinics] = await connection.query('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE grupoClinicaId=29 OR id_clinica IN (66,72) ORDER BY id_clinica');
  assert(stableJson(clinics.map(row => [Number(row.id_clinica), Number(row.grupoClinicaId)])) === stableJson([[66,29],[72,29]]), 'ADDRESS_DATABASE_SCOPE_MISMATCH');
  const tables = ['Pacientes', 'PacienteClinicas', 'PatientCustomFields', 'Clinicas'];
  const [engines] = await connection.query('SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (?,?,?,?)', tables);
  assert(engines.length === tables.length && engines.every(row => row.ENGINE === 'InnoDB'), 'ADDRESS_TABLE_ENGINE_UNSAFE');
  const [triggers] = await connection.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE IN (?,?,?,?)', tables);
  assert(triggers.length === 0, 'ADDRESS_TABLE_TRIGGERS_UNSAFE');
  const [columns] = await connection.query('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=\'Pacientes\' AND COLUMN_NAME IN (?,?,?,?,?)', ADDRESS_FIELDS);
  const types = { direccion: 'text', codigo_postal: 'varchar(32)', poblacion: 'varchar(255)', provincia: 'varchar(255)', pais: 'varchar(255)' };
  assert(columns.length === 5 && columns.every(row => row.COLUMN_TYPE.toLowerCase() === types[row.COLUMN_NAME] && row.IS_NULLABLE === 'YES' && !row.EXTRA), 'ADDRESS_COLUMN_SCHEMA_MISMATCH');
  return { database_name: identity[0].database_name, server_uuid: identity[0].server_uuid,
    scope: SCOPE, columns_sha256: hash(columns.sort((a,b) => a.COLUMN_NAME.localeCompare(b.COLUMN_NAME))) };
}

async function captureAddressSnapshot(connection, { lock = false } = {}) {
  const suffix = lock ? ' FOR UPDATE' : '';
  // Deliberately no patient names, phones, notes, clinical JSON or login data.
  // Avoid OR EXISTS: on CRM that scans the whole patient primary index and
  // would lock unrelated clinics under RR. Discover scoped IDs through their
  // clinic index, lock memberships, then read bounded primary-key batches.
  const [primaryIds] = await connection.query(`SELECT id_paciente FROM Pacientes FORCE INDEX (clinica_id) WHERE clinica_id IN (66,72) ORDER BY id_paciente${suffix}`);
  const [memberships] = await connection.query(`SELECT id,paciente_id,clinica_id FROM PacienteClinicas WHERE clinica_id IN (66,72) ORDER BY paciente_id,clinica_id${suffix}`);
  const ids = [...new Set([...primaryIds.map(row => Number(row.id_paciente)), ...memberships.map(row => Number(row.paciente_id))])].sort((a,b) => a-b);
  const patients = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset,offset+500);
    const [rows] = await connection.query(`SELECT ${PATIENT_COLUMNS.map(name => `\`${name}\``).join(',')} FROM Pacientes FORCE INDEX (PRIMARY) WHERE id_paciente IN (${batch.map(() => '?').join(',')}) ORDER BY id_paciente${suffix}`,batch);
    assert(rows.length === batch.length, 'ADDRESS_PATIENT_OWNER_CHANGED');
    patients.push(...rows);
  }
  const byPatient = new Map(patients.map(row => [Number(row.id_paciente), row]));
  for (const patient of patients) patient.memberships = [];
  for (const member of memberships) {
    const patient = byPatient.get(Number(member.paciente_id));
    assert(patient, 'ADDRESS_MEMBERSHIP_OWNER_CHANGED');
    patient.memberships.push(member);
  }
  // Include every retained marker/alias for scoped contacts. Invalid text is
  // represented as null plus its fingerprint, never fetched as personal text.
  // Known account-5880 outside owners remain ambiguity evidence only.
  const [identityLinks] = await connection.query(`SELECT id,paciente_id,clinica_id,source_column,field_key,last_imported_at,SHA2(value,256) AS sha256,
    CASE WHEN TRIM(value) REGEXP '^[0-9]+$' THEN TRIM(value) ELSE NULL END AS source_contact_id
    FROM PatientCustomFields WHERE source='cliniccloud' AND source_column='idContacto'
    AND (clinica_id IN (66,72) OR paciente_id IN (SELECT known.paciente_id FROM PatientCustomFields known
      WHERE known.source='cliniccloud' AND JSON_UNQUOTE(JSON_EXTRACT(CASE WHEN JSON_VALID(known.value) THEN known.value ELSE '{}' END,'$.source_account'))='cliniccloud-5880'))
    ORDER BY id${suffix}`);
  // Project bounded batches. Materializing a JSON-typed contact inside SQL
  // avoids reparsing a large historical wrapper for every alias. The complete
  // contact (which may contain medical fields) never leaves the database.
  const [sourceIds] = await connection.query(`SELECT id FROM PatientCustomFields WHERE ${SOURCE_FILTER} ORDER BY id${suffix}`);
  const safe = 'contact_json';
  // Preserve absent vs explicitly null keys: a newer blank address must not
  // resurrect older values. JSON_EXTRACT also preserves type (number != text).
  const projection = CONTACT_KEYS.flatMap(key => [
    `'${key}'`, `JSON_ARRAY(JSON_CONTAINS_PATH(${safe},'one','$."${key}"'),JSON_EXTRACT(${safe},'$."${key}"'))`,
  ]).join(',');
  const nullable = value => value === 'null' || value === undefined ? null : value;
  const sources = [];
  for (let offset = 0; offset < sourceIds.length; offset += 500) {
    const ids = sourceIds.slice(offset,offset+500).map(row => row.id);
    const [raw] = await connection.query(`SELECT id,paciente_id,clinica_id,source_column,field_key,last_imported_at,sha256,valid_json,
      record_version,source_account,source_date,JSON_TYPE(contact_json) AS contact_type,JSON_OBJECT(${projection}) AS contact_projection
      FROM (SELECT id,paciente_id,clinica_id,source_column,field_key,last_imported_at,SHA2(value,256) AS sha256,
        JSON_VALID(value) AS valid_json,JSON_UNQUOTE(JSON_EXTRACT(${SAFE_JSON},'$.version')) AS record_version,
        JSON_UNQUOTE(JSON_EXTRACT(${SAFE_JSON},'$.source_account')) AS source_account,
        JSON_UNQUOTE(JSON_EXTRACT(${SAFE_JSON},'$.source_date')) AS source_date,JSON_EXTRACT(${SAFE_JSON},'$.contact') AS contact_json
        FROM PatientCustomFields WHERE id IN (${ids.map(() => '?').join(',')}) LIMIT 500${suffix}) address_projection ORDER BY id`, ids);
    for (const row of raw) {
      const contact = Number(row.valid_json) === 1 && row.contact_type === 'OBJECT' ? {} : null;
      if (contact) for (const [key, pair] of Object.entries(decode(row.contact_projection))) if (Number(pair[0]) === 1) contact[key] = pair[1];
      sources.push({ id: row.id, paciente_id: row.paciente_id, clinica_id: row.clinica_id, source_column: row.source_column,
        field_key: row.field_key, last_imported_at: row.last_imported_at, sha256: row.sha256, contact,
        record_version: nullable(row.record_version), source_account: nullable(row.source_account), source_date: nullable(row.source_date) });
    }
  }
  return { patients, sources, identityLinks };
}

function expectedAfter(snapshot, operations) {
  const changes = new Map(operations.map(operation => [Number(operation.patient_id), operation.updates]));
  return { ...snapshot, patients: snapshot.patients.map(patient => ({ ...patient, ...(changes.get(Number(patient.id_paciente)) || {}) })) };
}

async function writeOperations(connection, operations) {
  // Bulk statements keep the live transaction short. CASE ELSE preserves every
  // field not explicitly approved for that patient, including filled cells.
  for (let offset = 0; offset < operations.length; offset += 500) {
    const batch = operations.slice(offset, offset + 500), assignments = [], parameters = [];
    for (const field of ADDRESS_FIELDS) {
      const updates = batch.filter(operation => Object.hasOwn(operation.updates, field));
      if (!updates.length) continue;
      assignments.push(`\`${field}\`=CASE id_paciente ${updates.map(() => 'WHEN ? THEN ?').join(' ')} ELSE \`${field}\` END`);
      for (const operation of updates) parameters.push(operation.patient_id, operation.updates[field]);
    }
    assignments.push('updatedAt=updatedAt');
    parameters.push(...batch.map(operation => operation.patient_id));
    const [result] = await connection.query(`UPDATE Pacientes SET ${assignments.join(',')} WHERE id_paciente IN (${batch.map(() => '?').join(',')})`, parameters);
    assert(Number(result.affectedRows) === batch.length, 'ADDRESS_UPDATE_ROW_COUNT_MISMATCH');
  }
}

async function applyAddressBackfillPlan(connection, plan, { countries = { values: {}, provenance: null }, beforeWrite, expectedDatabase } = {}) {
  validateAddressBackfillPlan(plan);
  assert(typeof beforeWrite === 'function', 'DURABLE_ADDRESS_BACKUP_REQUIRED');
  let inTransaction = false;
  try {
    // Metadata preflight must not establish a stale RR snapshot before the
    // current-read locks below. Scope is checked again from the locked rows.
    const database = await preflightAddressDatabase(connection);
    if (expectedDatabase) assert(stableJson(database) === stableJson(expectedDatabase), 'ADDRESS_DATABASE_IDENTITY_CHANGED');
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.beginTransaction(); inTransaction = true;
    // Lock clinical scope and all minimal address evidence, then replan under
    // the same locks. Neither a concurrent manual edit nor a refreshed archive
    // may race an approved empty-cell plan. One atomic commit, no partial batch.
    const [lockedClinics] = await connection.query('SELECT id_clinica,grupoClinicaId FROM Clinicas WHERE grupoClinicaId=29 OR id_clinica IN (66,72) ORDER BY id_clinica FOR UPDATE');
    assert(stableJson(lockedClinics.map(row => [Number(row.id_clinica),Number(row.grupoClinicaId)])) === stableJson([[66,29],[72,29]]), 'ADDRESS_DATABASE_SCOPE_CHANGED');
    const snapshot = await captureAddressSnapshot(connection, { lock: true });
    // Data reads now hold table metadata locks as well. Detect a schema/trigger
    // change that happened between initial preflight and those locks; DDL
    // cannot race the subsequent checked UPDATE while this transaction lives.
    assert(stableJson(await preflightAddressDatabase(connection)) === stableJson(database), 'ADDRESS_DATABASE_METADATA_CHANGED');
    const rebuilt = buildAddressBackfillPlan({ ...snapshot, target: plan.target, countries, scope: SCOPE, generatedAt: plan.generated_at });
    assert(rebuilt.plan_sha256 === plan.plan_sha256, 'ADDRESS_PLAN_STALE');
    await beforeWrite({ snapshot, operations: plan.operations, database });
    if (plan.operations.length) await writeOperations(connection, plan.operations);
    const after = await captureAddressSnapshot(connection, { lock: true });
    assert(hash(after) === hash(expectedAfter(snapshot, plan.operations)), 'ADDRESS_AFTER_IMAGE_MISMATCH');
    const replay = buildAddressBackfillPlan({ ...after, target: plan.target, countries, scope: SCOPE, generatedAt: plan.generated_at });
    assert(replay.operations.length === 0, 'ADDRESS_BACKFILL_NOT_IDEMPOTENT');
    await connection.commit(); inTransaction = false;
    return { committed: true, patients_updated: plan.operations.length, fields_updated: plan.summary.fields_updated,
      before_sha256: hash(snapshot), after_sha256: hash(after), remaining_operations: replay.operations.length,
      patients_review: replay.summary.patients_review };
  } catch (error) {
    if (inTransaction) await connection.rollback().catch(() => {});
    throw error;
  }
}

module.exports = { CONTACT_KEYS, SCOPE, preflightAddressDatabase, captureAddressSnapshot, expectedAfter, applyAddressBackfillPlan };
