'use strict';

require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPatientLastCareReader, createSqlPatientLastCareRepository, ARRIAGA_BUNDLE, BATCH_SIZE, MAX_PATIENTS,
} = require('../../services/patientLastCare.service');

const NOW = '2026-11-12T12:00:00.000Z';
const digest = 'a'.repeat(64);
function historical(overrides = {}) {
  return {
    patient_id: 41, clinic_id: 1, source_record_id: '90071992547409931', identity_id: '90071992547409932', catalog_id: '1',
    source_system: 'arriaga_excel', source_instance: 'arriaga-excel-20261026:clinic-1', category: 'historical',
    source_database: 'procedencia servicios 2026.xlsx', source_table: '2026 servicios',
    source_key: digest, row_sha256: digest, database_sha256: digest, bundle_sha256: ARRIAGA_BUNDLE,
    identity_bundle_sha256: ARRIAGA_BUNDLE, catalog_bundle_sha256: ARRIAGA_BUNDLE, recorded_day: '2026-09-30',
    envelope_version: 'arriaga_patient_source_record/1', envelope_provider: 'arriaga_excel',
    envelope_instance: 'arriaga-excel-20261026:clinic-1', envelope_bundle_sha256: ARRIAGA_BUNDLE,
    envelope_day: '2026-09-30', envelope_clinic_id: '1', envelope_category: 'historical',
    envelope_source_key: digest, envelope_row_sha256: digest, envelope_database_sha256: digest,
    envelope_database: 'procedencia servicios 2026.xlsx', envelope_table: '2026 servicios',
    identity_subject_matches: 1, service_shape_valid: 1, administrative_record: 0, ...overrides,
  };
}
const native = overrides => ({ patient_id: 41, clinic_id: 1, appointment_id: '71', status: 'completada',
  occurred_at: '2026-08-01T09:00:00.000Z', ...overrides });
function fixture({ attendance = [], services = [], holds = [], now = NOW, timeZone = 'Europe/Madrid' } = {}) {
  const f = { calls: [], attendance, services, holds, canView: true, canViewSensitive: true, sessionValid: true,
    actorId: 501, sessionRef: 'fictitious-session', memberships: true };
  const repository = {
    memberships: async input => {
      f.calls.push(['memberships', input]);
      if (f.failMembership) throw Error('PRIVATE_SQL_DATA');
      if (!f.memberships) return [];
      return input.patientIds.map(patient_id => ({ patient_id, clinic_id: input.clinicId }));
    },
    nativeAppointments: async input => {
      f.calls.push(['native', input]); await f.onRead?.();
      if (f.failNative) throw Error('PRIVATE_SQL_DATA');
      return f.attendance;
    },
    historicalServices: async input => {
      f.calls.push(['historical', input]);
      if (f.failHistorical) throw Error('PRIVATE_SQL_DATA');
      return f.services;
    },
    importedHolds: async input => {
      f.calls.push(['holds', input]);
      if (f.failHolds) throw Error('PRIVATE_SQL_DATA');
      return f.holds;
    },
  };
  f.repository = repository;
  f.reader = createPatientLastCareReader({ repository, now: () => new Date(now), resolveTimeZone: () => timeZone, authorize: async input => {
    f.calls.push(['authorize', input]);
    if (!f.sessionValid) throw Object.assign(Error('PRIVATE_SESSION'), { status: 401 });
    if (!f.canView || !f.canViewSensitive) throw Object.assign(Error('PRIVATE_PERMISSION'), { status: 403 });
    return { actorId: f.actorId, sessionRef: f.sessionRef };
  } });
  f.read = (clinicId = 1, patientIds = [41]) => f.reader.read({ clinicId, patientIds });
  return f;
}

test('factory has no I/O and rejects missing dependencies or malformed scopes before any read', async () => {
  assert.throws(() => createPatientLastCareReader(), { code: 'patient_last_care_dependencies_required' });
  const f = fixture(); assert.deepEqual(f.calls, []);
  for (const args of [{}, { clinicId: true, patientIds: [41] }, { clinicId: 1, patientIds: [true] },
    { clinicId: 1, patientIds: ['41 OR 1=1'] }, { clinicId: 1, patientIds: ['041'] },
    { clinicId: 1, patientIds: [0] }, { clinicId: 1, patientIds: [Number.MAX_SAFE_INTEGER + 1] },
    { clinicId: 1, patientIds: Array(MAX_PATIENTS + 1).fill(41) }]) {
    await assert.rejects(f.reader.read(args), { code: 'patient_last_care_scope_invalid', status: 400 });
  }
  assert.deepEqual(f.calls, []);
});

test('returns the latest performed care while keeping attendance, imported service and provenance separate', async () => {
  const f = fixture({ attendance: [native()], services: [historical()], holds: [{ patient_id: 41, messages_hold: 1 }] });
  const { items: [item] } = await f.read();
  assert.equal(item.latestAttendance.date, '2026-08-01');
  assert.equal(item.latestPerformedService.date, '2026-09-30');
  assert.equal(item.latestCare.date, '2026-09-30'); assert.equal(item.latestCare.kind, 'performed_service_import');
  assert.equal(item.latestCare.provenance[0].sourceRecordId, '90071992547409931', 'BIGINT provenance is never coerced to Number');
  assert.equal(item.latestCare.provenance[0].qualificationVersion, 'arriaga-confirmed-performed-services/1');
  assert.equal(item.importedMessagesHold, true); assert.equal(item.communicationEligibility, 'not_assessed');
  assert.deepEqual(f.calls.filter(([name]) => name === 'authorize').map(([, input]) => input.phase), ['before', 'after']);
  assert.equal(f.calls.filter(([name]) => name === 'memberships').length, 2);
});

test('newer native attendance wins and an equal day preserves evidence from both sources and every tied service', async () => {
  const later = fixture({ attendance: [native({ occurred_at: '2026-10-01T09:00:00Z' })], services: [historical()] });
  assert.equal((await later.read()).items[0].latestCare.kind, 'attended_appointment');
  const f = fixture({ attendance: [native({ occurred_at: '2026-09-30T09:00:00Z' })],
    services: [historical(), historical({ source_record_id: '90071992547409933' })] });
  const item = (await f.read()).items[0];
  assert.equal(item.latestCare.kind, 'attended_appointment'); assert.equal(item.latestCare.provenance.length, 3);
  assert.equal(item.latestPerformedService.provenance.length, 2);
});

test('native projection retains the latest actual instant and rejects pending, invalid or future dates', async () => {
  const f = fixture({ attendance: [native(), native({ appointment_id: '72', occurred_at: '2026-08-01T10:00:00Z' }),
    native({ appointment_id: '73', occurred_at: '2026-08-01T08:00:00Z' })] });
  assert.deepEqual((await f.read()).items[0].latestAttendance.provenance.map(p => p.appointmentId), ['72']);
  for (const overrides of [{ status: 'pendiente' }, { status: 'cancelada' }, { status: 'no_asistio' },
    { occurred_at: '2026-11-13T09:00:00Z' }, { occurred_at: '2026-02-30T09:00:00Z' },
    { occurred_at: '2026-09-30' }, { occurred_at: 'not a date' }]) {
    const item = (await fixture({ attendance: [native(overrides)] }).read()).items[0];
    assert.equal(item.latestCare, null); assert.equal(item.latestAttendance, null);
  }
  for (const status of ['ha_acudido', 'en_atencion', 'completada']) {
    assert.ok((await fixture({ attendance: [native({ status })] }).read()).items[0].latestCare);
  }
});

test('does not infer care from generic historical, administrative, unknown or incoherent envelopes', async () => {
  for (const overrides of [
    { source_system: 'another-provider' }, { source_instance: 'another-batch' }, { category: 'economy' },
    { envelope_version: 'unknown/1' }, { bundle_sha256: digest }, { identity_bundle_sha256: digest },
    { catalog_bundle_sha256: digest }, { envelope_bundle_sha256: digest }, { envelope_source_key: 'b'.repeat(64) },
    { envelope_row_sha256: 'b'.repeat(64) }, { envelope_database_sha256: 'b'.repeat(64) },
    { envelope_clinic_id: '70' }, { envelope_day: '2025-01-01' }, { identity_subject_matches: 0 },
    { service_shape_valid: 0 }, { administrative_record: 1 }, { administrative_record: undefined },
    { source_database: 'payments.xlsx', envelope_database: 'payments.xlsx' },
    { source_table: 'Pagos', envelope_table: 'Pagos' },
    { recorded_day: '2026-02-30', envelope_day: '2026-02-30' },
    { recorded_day: '2026-11-13', envelope_day: '2026-11-13' },
  ]) {
    const item = (await fixture({ services: [historical(overrides)] }).read()).items[0];
    assert.equal(item.latestPerformedService, null, JSON.stringify(overrides));
    assert.equal(item.latestCare, null);
  }
});

test('the same patient in two clinics keeps a separate result and cannot receive another clinic date', async () => {
  const a = fixture({ services: [historical()] });
  assert.equal((await a.read()).items[0].latestCare.date, '2026-09-30');
  const b = fixture({ services: [historical({ clinic_id: 70, source_instance: 'arriaga-excel-20261026:clinic-70',
    envelope_instance: 'arriaga-excel-20261026:clinic-70', envelope_clinic_id: '70',
    recorded_day: '2026-10-02', envelope_day: '2026-10-02' })] });
  const item = (await b.read(70)).items[0];
  assert.equal(item.patientId, 41); assert.equal(item.clinicId, 70); assert.equal(item.latestCare.date, '2026-10-02');
  for (const row of [historical({ clinic_id: 70 }), historical({ patient_id: 42 })]) {
    await assert.rejects(fixture({ services: [row] }).read(), { code: 'patient_last_care_scope_mismatch', status: 403 });
  }
  await assert.rejects(fixture({ attendance: [native({ clinic_id: 70 })] }).read(), { code: 'patient_last_care_scope_mismatch' });
});

test('missing session or either feature denies before any data query; membership denial precedes care reads', async () => {
  for (const flag of ['sessionValid', 'canView', 'canViewSensitive']) {
    const f = fixture({ services: [historical()] }); f[flag] = false;
    await assert.rejects(f.read(), error => [401, 403].includes(error.status));
    assert.deepEqual(f.calls.map(([name]) => name), ['authorize']);
  }
  const f = fixture(); f.memberships = false;
  await assert.rejects(f.read(), { code: 'patient_last_care_patient_scope_denied', status: 403 });
  assert.deepEqual(f.calls.map(([name]) => name), ['authorize', 'memberships']);
});

test('revocation during reads revalidates both features, session and exact membership before disclosure', async () => {
  for (const flag of ['sessionValid', 'canView', 'canViewSensitive', 'memberships']) {
    const f = fixture({ services: [historical()] }); f.onRead = () => { f[flag] = false; };
    await assert.rejects(f.read(), error => [401, 403].includes(error.status));
  }
  for (const field of ['actorId', 'sessionRef']) {
    const f = fixture({ services: [historical()] }); f.onRead = () => { f[field] = field === 'actorId' ? 502 : 'different-session'; };
    await assert.rejects(f.read(), { code: 'patient_last_care_authority_changed', status: 403 });
  }
});

test('verified legacy authority may return explicit null without inventing a managed-session ID', async () => {
  const f = fixture({ services: [historical()] }); f.sessionRef = null;
  assert.equal((await f.read()).items[0].latestCare.date, '2026-09-30');
  f.onRead = () => { f.sessionRef = 'new-managed-session'; };
  await assert.rejects(f.read(), { code: 'patient_last_care_authority_changed' });
  const missing = createPatientLastCareReader({ repository: fixture().repository, authorize: async () => ({ actorId: 501 }) });
  await assert.rejects(missing.read({ clinicId: 1, patientIds: [41] }), { code: 'patient_last_care_authority_required' });
});

test('native days and historical cutoff use the clinic civil day, including DST, without shifting DATEONLY values', async () => {
  const f = fixture({ now: '2026-07-01T23:45:00Z', attendance: [native({ occurred_at: '2026-07-01T23:30:00Z' })],
    services: [historical({ recorded_day: '2026-07-02', envelope_day: '2026-07-02' })] });
  const result = await f.read();
  assert.equal(result.timeZone, 'Europe/Madrid');
  assert.equal(result.items[0].latestAttendance.date, '2026-07-02');
  assert.equal(result.items[0].latestPerformedService.date, '2026-07-02');
  assert.equal(f.calls.find(([name]) => name === 'historical')[1].today, '2026-07-02');
  for (const instant of ['2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']) {
    const dst = fixture({ attendance: [native({ occurred_at: instant })] });
    assert.equal((await dst.read()).items[0].latestAttendance.date, instant.slice(0, 10));
  }
  const invalid = fixture({ timeZone: 'invalid/timezone' });
  await assert.rejects(invalid.read(), { code: 'patient_last_care_timezone_invalid' });
  assert.equal(invalid.calls.some(([name]) => name === 'native'), false);
});

test('batching is bounded, deduplicated and rechecks each exact patient/clinic pair', async () => {
  const f = fixture();
  const ids = Array.from({ length: BATCH_SIZE + 1 }, (_, index) => index + 1);
  const result = await f.read(1, [...ids, 1]);
  assert.equal(result.items.length, BATCH_SIZE + 1);
  for (const [, input] of f.calls) if (input.patientIds) assert.ok(input.patientIds.length <= BATCH_SIZE);
  assert.deepEqual(f.calls.filter(([name]) => name === 'memberships').map(([, input]) => input.patientIds.length), [200, 1, 200, 1]);
  assert.deepEqual(f.calls.filter(([name]) => name === 'holds').map(([, input]) => Object.keys(input)), [['patientIds'], ['patientIds']],
    'import holds stay global per patient, independently of the current clinic');
});

test('failures do not disclose partial results or private SQL details and evidence overflow is not silently truncated', async () => {
  for (const flag of ['failMembership', 'failNative', 'failHistorical', 'failHolds']) {
    const f = fixture({ attendance: [native()] }); f[flag] = true;
    await assert.rejects(f.read(), error => error.status === 503 && error.message === 'patient_last_care_source_unavailable');
  }
  await assert.rejects(fixture({ services: Array(5001).fill(historical()) }).read(), { code: 'patient_last_care_source_limit', status: 503 });
  const noAuthority = createPatientLastCareReader({ repository: fixture().repository, authorize: async () => true });
  await assert.rejects(noAuthority.read({ clinicId: 1, patientIds: [41] }), { code: 'patient_last_care_authority_required' });
});

test('holds do not disappear and a date is never an eligibility decision or a projection of clinical notes', async () => {
  const f = fixture({ services: [historical({ record_json: 'PRIVATE_CLINICAL_CONTENT', service_label: 'PRIVATE_SERVICE' })],
    holds: [{ patient_id: 41, messages_hold: 1 }, { patient_id: 41, messages_hold: 0 }] });
  const result = await f.read();
  assert.equal(result.items[0].importedMessagesHold, true);
  assert.equal(result.items[0].communicationEligibility, 'not_assessed');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(result).includes('custom_fields'), false);
  assert.equal(JSON.stringify(result).includes('care_completed_at'), false);
  assert.deepEqual(f.calls.map(([name]) => name), ['authorize', 'memberships', 'native', 'historical', 'holds', 'memberships', 'authorize']);
});

test('SQL adapter binds all scope values, computes maxima only after qualifying historical records and returns metadata only', async () => {
  const calls = [];
  const repo = createSqlPatientLastCareRepository({ query: async (sql, params) => { calls.push({ sql, params }); return []; } });
  assert.deepEqual(calls, []);
  const input = { clinicId: 1, patientIds: [41], now: NOW, today: '2026-11-12', rowLimit: 5001 };
  await repo.memberships(input); await repo.nativeAppointments(input); await repo.historicalServices(input); await repo.importedHolds({ patientIds: [41] });
  for (const call of calls) {
    assert.match(call.sql, /^SELECT|^WITH/); assert.doesNotMatch(call.sql, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i);
    assert.match(call.sql, /:patientIds/); assert.equal(call.sql.includes('41'), false);
  }
  assert.match(calls[0].sql, /p\.clinica_id=:clinicId OR EXISTS/);
  assert.match(calls[0].sql, /p\.fecha_baja IS NULL/);
  assert.match(calls[0].sql, /pc\.paciente_id=p\.id_paciente AND pc\.clinica_id=:clinicId/);
  assert.match(calls[1].sql, /MAX\(inicio\)/); assert.match(calls[1].sql, /GROUP BY paciente_id,clinica_id/);
  assert.equal(calls[1].params.now, '2026-11-12 12:00:00.000');
  const historicalSql = calls[2].sql;
  assert.match(historicalSql, /i\.id=s\.identity_id AND i\.patient_id=s\.patient_id AND i\.clinic_id=s\.clinic_id/);
  assert.match(historicalSql, /c\.id=i\.catalog_id AND c\.clinic_id=i\.clinic_id/);
  assert.ok(historicalSql.indexOf('qualified AS') < historicalSql.indexOf('MAX(recorded_day)'));
  assert.match(historicalSql, /GROUP BY patient_id,clinic_id/);
  assert.match(historicalSql, /SELECT q\.\* FROM qualified/);
  assert.equal(calls[2].params.bundle, ARRIAGA_BUNDLE);
  assert.equal(calls[2].params.sourceInstance, 'arriaga-excel-20261026:clinic-1');
  assert.match(historicalSql, /service_shape_valid=1 AND administrative_record=0/);
  assert.doesNotMatch(calls[3].sql, /clinic_id/);
  const count = calls.length;
  assert.deepEqual(await repo.historicalServices({ ...input, clinicId: 2 }), []);
  assert.equal(calls.length, count, 'another clinic does not acquire access to the reviewed Arriaga batch');
});
