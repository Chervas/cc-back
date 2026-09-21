'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash, localToUtc } = require('../../lib/cliniccloud-import/adapter');
const { prepareDistinctVisit, validateDistinctVisit, assertFreshDistinctVisit } = require('../../lib/cliniccloud-import/distinct-visits');
const { prepareWeekAppointments, verifyWeekPackage, appointmentPayload } = require('../../lib/cliniccloud-import/week-appointments');
const { createWeekAppointmentsStore } = require('../../lib/cliniccloud-import/week-appointments-store');

function fixture() {
  const source = { kind: 'appointment', source_contact_id: '90001', start_local: '2026-09-23T18:30:00', end_local: '2026-09-23T18:45:00',
    start_utc: localToUtc('2026-09-23T18:30:00'), end_utc: localToUtc('2026-09-23T18:45:00'),
    agenda_key: 'CABINA A', service_key: 'TRATAMIENTO DE PRUEBA', details: 'Revisión explícita ficticia', status: 'pendiente', validation_errors: [] };
  const nativeRow = { id_cita: 101, paciente_id: 7, clinica_id: 72, tipo_cita: 'primera_sin_trat', estado: 'info_enviada',
    inicio: '2026-09-03 15:15:00', fin: '2026-09-03 15:20:00', source_system: null, source_reference: null,
    created_at: '2026-09-01 10:00:00', updated_at: '2026-09-01 10:00:00', nota: null };
  const raw = { idEmpresa: 5880, idContacto: 90001, idCita: 200, estado: 0, fechaIni: '2026-09-23', fechaFin: '2026-09-23',
    horaIni: '18:30:00', horaFin: '18:45:00', marcaRealizada: null, agenda: { nombre: 'Cabina A' },
    conceptos: [{ asunto: 'Tratamiento de prueba' }], detalles: source.details };
  const history = { source_account: 'cliniccloud-5880', captured_at: '2026-09-21T10:00:00Z', patients: [{ contact_id: '90001', rows: [raw,
    { ...raw, idCita: 199, estado: 1, fechaIni: '2026-09-17', fechaFin: '2026-09-17', marcaRealizada: '2026-09-17 18:46:00' }] }] };
  const action = { action_key: 'a', entity: 'appointment', action: 'review', source, patient_id: 7,
    reasons: ['POSSIBLE_RESCHEDULE_OR_NATIVE_DUPLICATE', 'RESOURCE_AND_SERVICE_MAP_REQUIRED'], candidate_local_ids: [101],
    provenance: { file_sha256: 'a'.repeat(64), row_sha256: 'b'.repeat(64), source_row: 1, row_key: 'synthetic:1' } };
  return { action, nativeRow, history, historyEvidenceSha256: hash(history), reviewedBy: 'QA operator',
    reason: 'Separate future visit corroborated by later completed source encounters; preserve native first visit unchanged.',
    now: Date.parse('2026-09-21T10:05:00Z') };
}
function reviewedPackage(f) {
  const distinct = prepareDistinctVisit(f);
  const snapshot = { database_target: 'crm', database_group_id: 29, source_account: 'cliniccloud-5880', complete_for: { clinic_ids: [66, 72] },
    patients: [{ id: 7, source_contact_ids: ['90001'] }], appointments: [{ id: 101, patient_id: 7, source_system: null, end_local: '2026-09-03T17:20:00' }] };
  const plan = { manifest: { source_system: 'cliniccloud', source_account: 'cliniccloud-5880', snapshot_sha256: hash(snapshot), timezone: 'Europe/Madrid',
    automation_policy: 'hold', coverage: { start: '2026-09-01', end: '2026-12-31', authority: 'source_snapshot_plus_protected_native' } }, actions: [f.action] };
  plan.plan_sha256 = hash(plan);
  const review = { plan_sha256: plan.plan_sha256, reviewed_by: f.reviewedBy, reviewed_at: new Date(f.now).toISOString(), week: { start: '2026-09-21', end: '2026-09-27' },
    decisions: [{ action_key: 'a', disposition: 'create', reason: f.reason, distinct_visit: distinct,
      assignment: { clinic_id: 72, doctor_id: null, installation_id: null, treatment_id: null, appointment_type: 'continuacion' },
      pending_assignment: ['doctor_id', 'installation_id', 'treatment_id'], evidence: [f.reason] }] };
  return { snapshot, plan, review, target: 'crm' };
}
test('explicit distinct-visit receipt preserves a native first visit without asserting it was completed', () => {
  const f = fixture(), before = structuredClone(f), review = prepareDistinctVisit(f);
  assert.equal(review.preserved_native.estado, 'info_enviada');
  assert.equal(review.current.appointment_id, '200');
  assert.equal(review.prior_encounters[0].appointment_id, '199');
  assert.equal(validateDistinctVisit(review, f.action), review);
  assert.deepEqual(f, before);
});
for (const [label, mutate] of [
  ['additional local candidate', f => f.action.candidate_local_ids.push(102)],
  ['other review reason', f => f.action.reasons.push('CLAIMED_PATIENT_INTERVAL_OVERLAP')],
  ['native visit in the future interval', f => { f.nativeRow.inicio = '2026-09-23 16:30:00'; f.nativeRow.fin = '2026-09-23 16:40:00'; }],
  ['non-first native visit', f => { f.nativeRow.tipo_cita = 'continuacion'; }],
  ['another patient', f => { f.nativeRow.paciente_id = 8; }],
  ['imported candidate', f => { f.nativeRow.source_system = 'cliniccloud'; }],
  ['source changed its state', f => { f.history.patients[0].rows[0].estado = -2; }],
  ['ambiguous current source', f => f.history.patients[0].rows.push({ ...f.history.patients[0].rows[0], idCita: 201 })],
  ['source account mismatch', f => { f.history.patients[0].rows[1].idEmpresa = 9999; }],
  ['no corroborating completed encounter', f => { f.history.patients[0].rows[1].estado = 0; }],
  ['paid marker without evidence of performance', f => { f.history.patients[0].rows[1].estado = 3; f.history.patients[0].rows[1].marcaRealizada = null; }],
  ['history predates the preserved native visit', f => { f.history.patients[0].rows[1].fechaIni = '2026-09-02'; }],
  ['old evidence', f => { f.now += 3600000; }],
  ['future evidence', f => { f.now -= 3600000; }],
]) test(`review rejects ${label}`, () => {
  const f = fixture(); mutate(f);
  assert.throws(() => prepareDistinctVisit(f), /INVALID/);
});

test('receipt tampering and stale execution fail', () => {
  const f = fixture(), r = prepareDistinctVisit(f);
  assert.throws(() => validateDistinctVisit({ ...r, patient_id: 8 }), /INVALID/);
  assert.throws(() => assertFreshDistinctVisit(r, f.now + 3600000), /EXPIRED/);
});
test('week package retains original review action and stores all HOLD flags', () => {
  const input = reviewedPackage(fixture()), original = structuredClone(input.plan);
  const pkg = prepareWeekAppointments(input);
  verifyWeekPackage(pkg); assert.deepEqual(input.plan, original);
  const row = appointmentPayload(pkg.operations[0], pkg, { reviewed_by: 'QA' }, Date.now());
  assert.equal(row.tipo_cita, 'continuacion');
  assert.equal(row.import_metadata.cliniccloud_distinct_visit.preserved_native.id_cita, 101);
  assert.deepEqual(row.import_metadata.notification_suppression, { appointment_details: true, day_before: true, same_day: true });
  assert.equal(pkg.changes_existing_appointments, false);
  delete input.review.decisions[0].distinct_visit;
  assert.throws(() => prepareWeekAppointments(input), /WEEK_CREATION_NOT_UNAMBIGUOUS/);
});
test('a distinct-visit approval does not authorize a revised time or a new first visit', () => {
  const input = reviewedPackage(fixture()); input.review.decisions[0].assignment.appointment_type = 'primera_sin_trat';
  assert.throws(() => prepareWeekAppointments(input), /SCOPE_INVALID/);
});
test('SQL preflight rejects changed preserved row and an already-linked source ID', async () => {
  const f = fixture(), pkg = prepareWeekAppointments(reviewedPackage(f)), calls = [];
  const connection = { query: async (sql, args) => {
    calls.push([sql, args]); let rows = [];
    if (sql.startsWith('SELECT id_clinica,grupoClinicaId')) rows = [66, 72].map(id_clinica => ({ id_clinica, grupoClinicaId: 29 }));
    else if (sql.includes('information_schema.KEY_COLUMN_USAGE')) rows = [{ COLUMN_NAME: 'paciente_id', REFERENCED_TABLE_NAME: 'Pacientes' }];
    else if (sql.startsWith('SELECT id_paciente,clinica_id')) rows = [{ id_paciente: 7, clinica_id: 72 }];
    else if (sql.startsWith('SELECT * FROM CitasPacientes')) rows = [{ ...f.nativeRow, nota: 'Later staff edit' }];
    else if (sql.includes('DISTINCT pc.paciente_id')) rows = [{ paciente_id: 7 }];
    else if (sql.includes('JSON_SEARCH')) rows = [{ id_cita: 500 }];
    return [rows];
  } };
  const store = await createWeekAppointmentsStore(connection, { groupId: 29 });
  assert.deepEqual((await store.validate(pkg.operations[0], pkg)).reasons, ['PRESERVED_NATIVE_VISIT_CHANGED', 'DISTINCT_SOURCE_ALREADY_LINKED']);
  assert(calls.every(([sql]) => !/^(UPDATE|INSERT|DELETE)/.test(sql)));
});
