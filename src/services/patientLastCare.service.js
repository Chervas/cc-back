'use strict';

const { resolveClinicTimezone, isValidTimeZone, formatDateLocal } = require('../lib/availability-calendar');

// A read-only, scoped projection. Creating the factory performs no I/O and does
// not load application models, a worker, an importer or a messaging transport.
const BATCH_SIZE = 200;
const MAX_PATIENTS = 10000;
const ROW_LIMIT = 5000;
const ARRIAGA_BUNDLE = 'e8dad996b869e524dc42eb97c0685dc48693557f90277932a08a044d7c084b41';
const ATTENDED = new Set(['ha_acudido', 'en_atencion', 'completada']);
const ORIGINS = Object.freeze([
  Object.freeze({ database: 'procedencia servicios 2025.xlsx', table: 'listado 2025' }),
  Object.freeze({ database: 'procedencia servicios 2026.xlsx', table: '2026 servicios' }),
]);
const historicalInstance = clinicId => [1, 70].includes(clinicId) ? `arriaga-excel-20261026:clinic-${clinicId}` : null;
const fail = (code, status = 503) => { throw Object.assign(Error(code), { code, status }); };
const positiveId = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const text = String(value);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
};
const recordId = value => typeof value === 'number' && !Number.isSafeInteger(value) ? null
  : /^[1-9]\d*$/.test(String(value ?? '')) ? String(value) : null;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const yes = value => value === true || value === 1 || value === '1';
const chunks = values => Array.from({ length: Math.ceil(values.length / BATCH_SIZE) }, (_, i) => values.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE));

function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
function instant(value) {
  if (!(value instanceof Date)) {
    const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match || !day(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function rows(value) {
  if (!Array.isArray(value) || value.length > ROW_LIMIT) fail('patient_last_care_source_limit');
  return value;
}
function scoped(row, clinicId, ids) {
  const patientId = positiveId(row?.patient_id);
  if (!patientId || !ids.has(patientId) || positiveId(row.clinic_id) !== clinicId) fail('patient_last_care_scope_mismatch', 403);
  return patientId;
}
function authority(value) {
  const legacy = value && Object.prototype.hasOwnProperty.call(value, 'sessionRef') && value.sessionRef === null;
  if (!positiveId(value?.actorId) || !legacy && (typeof value?.sessionRef !== 'string'
    || !value.sessionRef || value.sessionRef.length > 160 || /[\x00-\x20]/.test(value.sessionRef))) {
    fail('patient_last_care_authority_required', 403);
  }
  return { actorId: Number(value.actorId), sessionRef: value.sessionRef };
}
function historicalEvidence(row, clinicId, today) {
  const instance = historicalInstance(clinicId);
  const recordedDay = day(row.recorded_day);
  if (!instance || !recordedDay || recordedDay > today || row.source_system !== 'arriaga_excel'
    || row.source_instance !== instance || row.category !== 'historical'
    || row.envelope_version !== 'arriaga_patient_source_record/1' || row.envelope_provider !== 'arriaga_excel'
    || row.envelope_instance !== instance || row.bundle_sha256 !== ARRIAGA_BUNDLE
    || row.identity_bundle_sha256 !== ARRIAGA_BUNDLE || row.catalog_bundle_sha256 !== ARRIAGA_BUNDLE
    || row.envelope_bundle_sha256 !== ARRIAGA_BUNDLE || row.envelope_day !== recordedDay
    || positiveId(row.envelope_clinic_id) !== clinicId || row.envelope_category !== 'historical'
    || row.envelope_source_key !== row.source_key || row.envelope_row_sha256 !== row.row_sha256
    || row.envelope_database_sha256 !== row.database_sha256
    || row.envelope_database !== row.source_database || row.envelope_table !== row.source_table
    || !yes(row.identity_subject_matches) || !yes(row.service_shape_valid) || ![false, 0, '0'].includes(row.administrative_record)
    || !sha(row.source_key) || !sha(row.row_sha256) || !sha(row.database_sha256)
    || !recordId(row.source_record_id) || !recordId(row.identity_id) || !recordId(row.catalog_id)
    || !ORIGINS.some(origin => origin.database === row.source_database && origin.table === row.source_table)) return null;
  return { kind: 'performed_service_import', sourceRecordId: recordId(row.source_record_id), identityId: recordId(row.identity_id),
    catalogId: recordId(row.catalog_id), sourceSystem: 'arriaga_excel', sourceInstance: instance,
    sourceKey: row.source_key, rowSha256: row.row_sha256, databaseSha256: row.database_sha256,
    bundleSha256: ARRIAGA_BUNDLE, qualificationVersion: 'arriaga-confirmed-performed-services/1', precision: 'day' };
}
function mergeFact(current, date, evidence) {
  if (!current || date > current.date) return { date, kind: evidence.kind, precision: 'day', provenance: [evidence] };
  if (date === current.date) current.provenance.push(evidence);
  return current;
}
function combine(attendance, service) {
  if (!attendance) return service;
  if (!service || attendance.date > service.date) return attendance;
  if (service.date > attendance.date) return service;
  return { date: attendance.date, kind: 'attended_appointment', precision: 'day', provenance: [...attendance.provenance, ...service.provenance] };
}
function orderedFact(value) {
  if (!value) return null;
  return { ...value, provenance: [...value.provenance].sort((a, b) => {
    const ak = `${a.kind}:${a.appointmentId || a.sourceRecordId}`, bk = `${b.kind}:${b.appointmentId || b.sourceRecordId}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  }) };
}

function createPatientLastCareReader({ repository, authorize, now = () => new Date(), resolveTimeZone = () => resolveClinicTimezone(null) } = {}) {
  const methods = ['memberships', 'nativeAppointments', 'historicalServices', 'importedHolds'];
  if (typeof authorize !== 'function' || typeof resolveTimeZone !== 'function' || !repository || methods.some(name => typeof repository[name] !== 'function')) {
    fail('patient_last_care_dependencies_required', 503);
  }
  return {
    async read({ clinicId, patientIds } = {}) {
      clinicId = positiveId(clinicId);
      if (!clinicId || !Array.isArray(patientIds) || patientIds.length > MAX_PATIENTS || patientIds.some(id => !positiveId(id))) {
        fail('patient_last_care_scope_invalid', 400);
      }
      const ids = [...new Set(patientIds.map(positiveId))].sort((a, b) => a - b);
      const at = instant(now());
      if (!at) fail('patient_last_care_clock_invalid');
      const authorizeStep = async phase => {
        let value;
        try { value = await authorize({ clinicId, phase }); }
        catch (error) {
          const status = error?.status || error?.httpStatus;
          fail(status === 401 ? 'patient_last_care_session_required' : status === 403
            ? 'patient_last_care_authority_required' : 'patient_last_care_authority_unavailable', [401, 403].includes(status) ? status : 503);
        }
        return authority(value);
      };
      const readSource = async (method, input) => {
        let value;
        try { value = await repository[method](input); }
        catch { fail('patient_last_care_source_unavailable'); }
        return rows(value);
      };
      const started = await authorizeStep('before');
      let timeZone;
      try { timeZone = await resolveTimeZone({ clinicId }); } catch { fail('patient_last_care_timezone_unavailable'); }
      if (!isValidTimeZone(timeZone)) fail('patient_last_care_timezone_invalid');
      const today = formatDateLocal(at, timeZone);
      const nativeInstants = new Map();
      const items = new Map(ids.map(patientId => [patientId, { patientId, clinicId, latestCare: null,
        latestAttendance: null, latestPerformedService: null, importedMessagesHold: null, communicationEligibility: 'not_assessed' }]));
      const checkMemberships = async batch => {
        const expected = new Set(batch), found = new Set();
        for (const row of await readSource('memberships', { clinicId, patientIds: batch })) found.add(scoped(row, clinicId, expected));
        if (found.size !== expected.size) fail('patient_last_care_patient_scope_denied', 403);
      };
      for (const batch of chunks(ids)) {
        await checkMemberships(batch);
        const expected = new Set(batch);
        const results = await Promise.allSettled([
          readSource('nativeAppointments', { clinicId, patientIds: batch, now: at.toISOString(), rowLimit: ROW_LIMIT + 1 }),
          readSource('historicalServices', { clinicId, patientIds: batch, today, rowLimit: ROW_LIMIT + 1 }),
          readSource('importedHolds', { patientIds: batch }),
        ]);
        const rejected = results.find(result => result.status !== 'fulfilled');
        if (rejected) throw rejected.reason;
        const [native, historical, holds] = results.map(result => rows(result.value));
        for (const row of native) {
          const patientId = scoped(row, clinicId, expected), occurred = instant(row.occurred_at);
          if (!ATTENDED.has(row.status) || !occurred || occurred > at || !recordId(row.appointment_id)) continue;
          const item = items.get(patientId);
          if (nativeInstants.has(patientId) && occurred.getTime() < nativeInstants.get(patientId)) continue;
          if (nativeInstants.get(patientId) !== occurred.getTime()) item.latestAttendance = null;
          nativeInstants.set(patientId, occurred.getTime());
          item.latestAttendance = mergeFact(item.latestAttendance, formatDateLocal(occurred, timeZone), {
            kind: 'attended_appointment', appointmentId: recordId(row.appointment_id), occurredAt: occurred.toISOString(),
            status: row.status, precision: 'instant', timeZone,
          });
        }
        for (const row of historical) {
          const patientId = scoped(row, clinicId, expected), evidence = historicalEvidence(row, clinicId, today);
          if (!evidence) continue;
          const item = items.get(patientId);
          item.latestPerformedService = mergeFact(item.latestPerformedService, row.recorded_day, evidence);
        }
        for (const row of holds) {
          const patientId = positiveId(row?.patient_id);
          if (!expected.has(patientId) || ![true, false, 0, 1, '0', '1'].includes(row.messages_hold)) fail('patient_last_care_hold_invalid');
          const item = items.get(patientId);
          // Global per patient, matching existing governance. This flag is not
          // a complete eligibility decision (legacy holds/opt-outs still apply).
          item.importedMessagesHold = item.importedMessagesHold === true || yes(row.messages_hold);
        }
      }
      // Always revalidate membership, session and features before disclosure,
      // regardless of audit feature flags or whether a patient has any dates.
      for (const batch of chunks(ids)) await checkMemberships(batch);
      const finished = await authorizeStep('after');
      if (started.actorId !== finished.actorId || started.sessionRef !== finished.sessionRef) fail('patient_last_care_authority_changed', 403);
      for (const item of items.values()) {
        item.latestAttendance = orderedFact(item.latestAttendance);
        item.latestPerformedService = orderedFact(item.latestPerformedService);
        item.latestCare = orderedFact(combine(item.latestAttendance, item.latestPerformedService));
      }
      return { clinicId, timeZone, items: [...items.values()] };
    },
  };
}

const MEMBERSHIPS_SQL = `SELECT p.id_paciente AS patient_id, :clinicId AS clinic_id FROM Pacientes p
  WHERE p.id_paciente IN (:patientIds) AND p.fecha_baja IS NULL AND (p.clinica_id=:clinicId OR EXISTS (
    SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id=p.id_paciente AND pc.clinica_id=:clinicId))`;
const NATIVE_SQL = `WITH latest AS (
  SELECT paciente_id,clinica_id,MAX(inicio) AS occurred_at FROM CitasPacientes
  WHERE paciente_id IN (:patientIds) AND clinica_id=:clinicId
    AND CAST(estado AS BINARY) IN ('ha_acudido','en_atencion','completada') AND inicio<=:now
  GROUP BY paciente_id,clinica_id
) SELECT c.paciente_id AS patient_id,c.clinica_id AS clinic_id,c.id_cita AS appointment_id,c.estado AS status,
  DATE_FORMAT(c.inicio,'%Y-%m-%dT%H:%i:%s.000Z') AS occurred_at
  FROM CitasPacientes c JOIN latest l ON l.paciente_id=c.paciente_id AND l.clinica_id=c.clinica_id AND l.occurred_at=c.inicio
  WHERE c.paciente_id IN (:patientIds) AND c.clinica_id=:clinicId AND CAST(c.estado AS BINARY) IN ('ha_acudido','en_atencion','completada')
  ORDER BY c.paciente_id,c.id_cita LIMIT :rowLimit`;
const HOLDS_SQL = `SELECT patient_id,MAX(messages_hold) AS messages_hold FROM PatientImportedIdentities
  WHERE patient_id IN (:patientIds) GROUP BY patient_id`;

// Only metadata and predicates over the retained envelope are projected. Raw
// record_json, service labels, notes, diagnoses and financial data never leave
// this query. Exact batch/origin qualification is not a generic historical gate.
const HISTORICAL_SQL = `WITH source_rows AS (
  SELECT s.*,i.catalog_id,i.source_system,i.source_instance,i.source_patient_id,
    i.bundle_sha256 AS identity_bundle_sha256,c.bundle_sha256 AS catalog_bundle_sha256,
    CASE WHEN JSON_VALID(s.record_json) THEN s.record_json ELSE '{}' END AS envelope
  FROM PatientImportedSourceRecords s JOIN PatientImportedIdentities i
    ON i.id=s.identity_id AND i.patient_id=s.patient_id AND i.clinic_id=s.clinic_id
  JOIN ImportedClinicalCatalogs c ON c.id=i.catalog_id AND c.clinic_id=i.clinic_id
    AND BINARY c.source_system=BINARY i.source_system AND BINARY c.source_instance=BINARY i.source_instance
  WHERE s.patient_id IN (:patientIds) AND s.clinic_id=:clinicId AND BINARY s.category=BINARY 'historical'
    AND BINARY i.source_system=BINARY 'arriaga_excel' AND BINARY i.source_instance=BINARY :sourceInstance
    AND BINARY s.bundle_sha256=BINARY :bundle AND BINARY i.bundle_sha256=BINARY :bundle AND BINARY c.bundle_sha256=BINARY :bundle
    AND s.record_date IS NOT NULL AND s.record_date<=:today
    AND ((BINARY s.source_database=BINARY :database2025 AND BINARY s.source_table=BINARY :table2025)
      OR (BINARY s.source_database=BINARY :database2026 AND BINARY s.source_table=BINARY :table2026))
), metadata AS (
  SELECT id AS source_record_id,identity_id,catalog_id,patient_id,clinic_id,source_system,source_instance,
    category,source_database,source_table,source_key,row_sha256,database_sha256,bundle_sha256,
    identity_bundle_sha256,catalog_bundle_sha256,DATE_FORMAT(record_date,'%Y-%m-%d') AS recorded_day,
    JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.version')) AS envelope_version,
    JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.provider')) AS envelope_provider,
    JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.source_instance')) AS envelope_instance,
    JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.bundle_sha256')) AS envelope_bundle_sha256,
    JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.record_date')) AS envelope_day,
    JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.clinic_id')) AS envelope_clinic_id,
    JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.category')) AS envelope_category,
    JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.source_key')) AS envelope_source_key,
    JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.row_sha256')) AS envelope_row_sha256,
    JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.database_sha256')) AS envelope_database_sha256,
    JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.source_database')) AS envelope_database,
    JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.source_table')) AS envelope_table,
    (BINARY JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.source_patient_id'))=BINARY source_patient_id) AS identity_subject_matches,
    (JSON_TYPE(JSON_EXTRACT(envelope,'$.record'))='OBJECT' AND JSON_LENGTH(JSON_EXTRACT(envelope,'$.record'))=4
      AND JSON_CONTAINS_PATH(envelope,'all','$.record.service_label','$.record.service_family',
        '$.record.source_classification','$.record.site_assignment')=1
      AND JSON_TYPE(JSON_EXTRACT(envelope,'$.record.service_label'))='STRING'
      AND LENGTH(TRIM(JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.record.service_label'))))>0) AS service_shape_valid,
    (UPPER(JSON_UNQUOTE(JSON_EXTRACT(envelope,'$.record.service_label'))) REGEXP
      '(^|[^[:alnum:]])(NOTAS?|AVISOS?|NO VIENE|NO ACUDE|PAGOS?|RESERVAS?|CONSENTIMIENTO|FACTURAS?|PRESUPUESTOS?)([^[:alnum:]]|$)') AS administrative_record
  FROM source_rows
), qualified AS (
  SELECT * FROM metadata WHERE BINARY envelope_version=BINARY 'arriaga_patient_source_record/1'
    AND BINARY envelope_provider=BINARY 'arriaga_excel' AND BINARY envelope_instance=BINARY source_instance AND BINARY envelope_bundle_sha256=BINARY bundle_sha256
    AND BINARY envelope_day=BINARY recorded_day AND BINARY envelope_clinic_id=BINARY CAST(clinic_id AS CHAR) AND BINARY envelope_category=BINARY category
    AND BINARY envelope_source_key=BINARY source_key AND BINARY envelope_row_sha256=BINARY row_sha256 AND BINARY envelope_database_sha256=BINARY database_sha256
    AND BINARY envelope_database=BINARY source_database AND BINARY envelope_table=BINARY source_table
    AND source_record_id>0 AND identity_id>0 AND catalog_id>0
    AND REGEXP_LIKE(source_key,'^[a-f0-9]{64}$','c') AND REGEXP_LIKE(row_sha256,'^[a-f0-9]{64}$','c') AND REGEXP_LIKE(database_sha256,'^[a-f0-9]{64}$','c')
    AND identity_subject_matches=1 AND service_shape_valid=1 AND administrative_record=0
), latest AS (
  SELECT patient_id,clinic_id,MAX(recorded_day) AS recorded_day FROM qualified GROUP BY patient_id,clinic_id
) SELECT q.* FROM qualified q JOIN latest l ON l.patient_id=q.patient_id AND l.clinic_id=q.clinic_id AND l.recorded_day=q.recorded_day
  ORDER BY q.patient_id,q.source_record_id LIMIT :rowLimit`;

function createSqlPatientLastCareRepository({ query } = {}) {
  if (typeof query !== 'function') fail('patient_last_care_query_required');
  return {
    memberships: input => query(MEMBERSHIPS_SQL, input),
    nativeAppointments: input => {
      const at = instant(input.now);
      if (!at) fail('patient_last_care_clock_invalid');
      return query(NATIVE_SQL, { ...input, now: at.toISOString().replace('T', ' ').replace('Z', '') });
    },
    historicalServices: input => historicalInstance(input.clinicId) ? query(HISTORICAL_SQL, { ...input,
      sourceInstance: historicalInstance(input.clinicId), bundle: ARRIAGA_BUNDLE,
      database2025: ORIGINS[0].database, table2025: ORIGINS[0].table,
      database2026: ORIGINS[1].database, table2026: ORIGINS[1].table,
    }) : Promise.resolve([]),
    importedHolds: input => query(HOLDS_SQL, input),
  };
}

module.exports = { createPatientLastCareReader, createSqlPatientLastCareRepository,
  BATCH_SIZE, MAX_PATIENTS, ARRIAGA_BUNDLE };
