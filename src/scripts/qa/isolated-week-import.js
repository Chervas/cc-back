#!/usr/bin/env node
'use strict';
// Exercise the real import SQL inside one outer transaction that ALWAYS rolls
// back. Temporary clinics/patient are synthetic; no clinical runtime is loaded.
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { connectOperatorDatabase, databaseOptions } = require('../../lib/cliniccloud-import/operator-database');
const { prepareWeekAppointments, executeWeekAppointments } = require('../../lib/cliniccloud-import/week-appointments');
const { createWeekAppointmentsStore } = require('../../lib/cliniccloud-import/week-appointments-store');
async function main() {
  assert.equal(process.env.QA_ISOLATED_CLINICAL_WRITES, 'bs-startup-isolated-20260920');
  assert.equal(databaseOptions('dev').database, 'clinicaclick_dev_isolated');
  const c = await connectOperatorDatabase('dev');
  try {
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await c.beginTransaction();
    const [existing] = await c.query('SELECT id_clinica FROM Clinicas WHERE id_clinica IN (66,72)'); assert.equal(existing.length, 0);
    const [group] = await c.query('INSERT INTO GruposClinicas (nombre_grupo) VALUES (?)', ['QA transaccional ficticia · importación semanal']);
    await c.query('INSERT INTO Clinicas (id_clinica,nombre_clinica,grupoClinicaId) VALUES (66,?,?),(72,?,?)', ['Clínica ficticia 66 · QA importación', group.insertId, 'Clínica ficticia 72 · QA importación', group.insertId]);
    const [patient] = await c.query('INSERT INTO Pacientes (public_id,nombre,apellidos,clinica_id) VALUES (?,?,?,66)', ['pac_09202026000000000002', 'Paciente ficticio', 'QA importación transaccional']);
    await c.query("INSERT INTO PatientCustomFields (paciente_id,clinica_id,field_key,value,source,source_column,created_at,updated_at) VALUES (?,66,'cliniccloud_source_contact_id','90001','cliniccloud','idContacto',UTC_TIMESTAMP(),UTC_TIMESTAMP())", [patient.insertId]);
    const [doctor] = await c.query('SELECT id_usuario,email_usuario FROM Usuarios WHERE id_usuario=220');
    assert(doctor[0].email_usuario.endsWith('@example.invalid'));
    await c.query('INSERT INTO DoctorClinicas (doctor_id,clinica_id,activo,recibe_citas,created_at,updated_at) VALUES (220,66,1,1,UTC_TIMESTAMP(),UTC_TIMESTAMP())');
    const [room] = await c.query("INSERT INTO Instalaciones (clinica_id,nombre,tipo,activo,created_at,updated_at) VALUES (66,'Cabina ficticia transaccional','consulta',1,UTC_TIMESTAMP(),UTC_TIMESTAMP())");
    const snapshot = { database_target: 'dev', database_group_id: Number(group.insertId), source_account: 'cliniccloud-5880',
      complete_for: { clinic_ids: [66,72] }, patients: [{ id: Number(patient.insertId), source_contact_ids: ['90001'] }], appointments: [] };
    const source = { source_contact_id: '90001', start_local: '2026-09-21T10:00:00', end_local: '2026-09-21T10:30:00',
      start_utc: '2026-09-21T08:00:00.000Z', end_utc: '2026-09-21T08:30:00.000Z', agenda_key: 'QA', service_key: 'Consulta ficticia',
      status: 'pendiente', details: 'Solo prueba transaccional sintética', validation_errors: [] };
    const action = { action_key: 'qa-week', entity: 'appointment', action: 'create_appointment_candidate', source,
      patient_id: Number(patient.insertId), reasons: ['RESOURCE_AND_SERVICE_MAP_REQUIRED'], candidate_local_ids: [], provenance: { file_sha256: 'a'.repeat(64), source_row: 1 } };
    const plan = { manifest: { source_system: 'cliniccloud', source_account: snapshot.source_account, snapshot_sha256: hash(snapshot),
      timezone: 'Europe/Madrid', automation_policy: 'hold', coverage: { start: '2026-09-01', end: '2026-12-31', authority: 'source_snapshot_plus_protected_native' } }, actions: [action] };
    plan.plan_sha256 = hash(plan);
    const review = { plan_sha256: plan.plan_sha256, reviewed_by: 'QA operator', reviewed_at: new Date().toISOString(), week: { start: '2026-09-21', end: '2026-09-27' },
      decisions: [{ action_key: action.action_key, disposition: 'create', reason: 'Synthetic fixture', evidence: ['Synthetic temporary clinician and cabin'],
        assignment: { clinic_id: 66, doctor_id: 220, installation_id: Number(room.insertId), treatment_id: null, appointment_type: 'primera_sin_trat' }, pending_assignment: ['treatment_id'] }] };
    const pkg = prepareWeekAppointments({ plan, snapshot, review, target: 'dev' });
    // Store transactions become savepoints; the integration test owns the only
    // real transaction. No test result can commit the fixture.
    const adapter = { query: (sql, values) => sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED' ? Promise.resolve([[]]) : c.query(sql, values),
      beginTransaction: () => c.query('SAVEPOINT qa_week_row'), commit: () => c.query('RELEASE SAVEPOINT qa_week_row'), rollback: () => c.query('ROLLBACK TO SAVEPOINT qa_week_row') };
    const store = await createWeekAppointmentsStore(adapter, { groupId: snapshot.database_group_id, readOnly: false });
    const journal = [];
    const options = { pkg, store, journal: { append: async r => journal.push(structuredClone(r)) }, approval: { package_sha256: pkg.package_sha256,
      automation_policy: 'hold', confirm_create_only: true, reviewed_by: 'QA operator', backup_manifest_sha256: 'a'.repeat(64), expires_at: new Date(Date.now() + 600000).toISOString() } };
    assert.equal((await executeWeekAppointments(options)).created, 1);
    assert.equal((await executeWeekAppointments(options)).replayed, 1);
    const [saved] = await c.query('SELECT * FROM CitasPacientes WHERE paciente_id=?', [patient.insertId]);
    assert.equal(saved.length, 1); assert.equal(saved[0].estado, 'pendiente');
    const metadata = typeof saved[0].import_metadata === 'string' ? JSON.parse(saved[0].import_metadata) : saved[0].import_metadata;
    assert.equal(metadata.notification_suppression.day_before, true);
    assert((await store.validate(pkg.operations[0], pkg)).reasons.includes('CURRENT_PATIENT_SLOT_REQUIRES_RECONCILIATION'));
    const [jobs] = await c.query("SELECT id FROM JobRequests WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.appointment_id'))=?", [String(saved[0].id_cita)]);
    assert.equal(jobs.length, 0);
    console.log(JSON.stringify({ ok: true, checks: ['SQL insert with exact clinic time and HOLD', 'SQL replay without duplicates', 'Live patient overlap deferral', 'No reminder jobs'], committed_rows: 0 }));
  } finally { await c.rollback(); await c.end(); }
}
main().catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || error.name, message: error.message })); process.exitCode = 1; });
