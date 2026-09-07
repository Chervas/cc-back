#!/usr/bin/env node
'use strict';

// The only DB-capable companion: an explicitly scoped, consistent READ ONLY
// transaction. Never imports models/app.js, schedules work or changes consent.
const path = require('path');
const { readCsv, writePrivateJson, parseArgs } = require('../lib/cliniccloud-import/io');
const { dateOnly, localToUtc, utcToLocal, normalizeAppointments, norm, index, hash } = require('../lib/cliniccloud-import/adapter');

async function run(args) {
  const options = parseArgs(args, ['--source-account', '--clinic-ids', '--coverage-start', '--coverage-end', '--historical-dir', '--private-output']);
  for (const key of ['--source-account', '--clinic-ids', '--coverage-start', '--coverage-end', '--historical-dir', '--private-output']) if (!options[key]) throw new Error('MISSING_REQUIRED_CLI_ARGUMENT');
  const clinicIds = options['--clinic-ids'].split(',').map(Number);
  if (clinicIds.length > 20 || !clinicIds.length || clinicIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new Error('INVALID_CLINIC_SCOPE');
  const start = dateOnly(options['--coverage-start']);
  const end = dateOnly(options['--coverage-end']);
  if (!start || !end || start > end) throw new Error('INVALID_COVERAGE');
  const directory = options['--historical-dir'];
  const agendas = readCsv(path.join(directory, 'agenda_1.csv'), 'historic_agendas').rows;
  const services = readCsv(path.join(directory, 'servicio_1.csv'), 'historic_services').rows;
  const serviceTypes = readCsv(path.join(directory, 'tiposervicio_1.csv'), 'historic_service_types').rows;
  const agendaIds = index(agendas, (r) => r.values.idAgenda);
  const serviceIds = index(services, (r) => r.values.idServicio);
  // dotenv quiet avoids startup logging; credentials never enter the snapshot.
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
  const mysql = require('mysql2/promise');
  const connection = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USERNAME, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, dateStrings: true, timezone: 'Z', multipleStatements: false });
  let snapshot;
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [clinics] = await connection.query('SELECT id_clinica, grupoClinicaId FROM Clinicas WHERE id_clinica IN (?)', [clinicIds]);
    if (clinics.length !== new Set(clinicIds).size || new Set(clinics.map((r) => r.grupoClinicaId)).size !== 1 || !clinics[0].grupoClinicaId) throw new Error('CLINICS_MUST_BELONG_TO_ONE_GROUP');
    const [rows] = await connection.query('SELECT id_cita, paciente_id, clinica_id, source_system, source_reference, import_metadata, inicio, fin, estado, doctor_id, instalacion_id, tratamiento_id, updated_at FROM CitasPacientes WHERE clinica_id IN (?) AND inicio >= ? ORDER BY id_cita', [clinicIds, localToUtc(`${start}T00:00:00`).replace('T', ' ').replace('Z', '')]);
    const [links] = await connection.query("SELECT paciente_id, value FROM PatientCustomFields WHERE clinica_id IN (?) AND source = 'cliniccloud' AND (source_column = 'idContacto' OR field_key = 'cliniccloud_source_contact_id')", [clinicIds]);
    const [rawIdentities] = await connection.query("SELECT paciente_id, JSON_UNQUOTE(JSON_EXTRACT(value, '$.contact.idContacto')) AS source_contact_id, JSON_UNQUOTE(JSON_EXTRACT(value, '$.contact.num')) AS history_number FROM PatientCustomFields WHERE clinica_id IN (?) AND source = 'cliniccloud' AND source_column = 'contacto_1.csv' AND JSON_VALID(value)", [clinicIds]);
    const [treatments] = await connection.query('SELECT id_tratamiento, nombre FROM Tratamientos WHERE id_tratamiento IN (SELECT tratamiento_id FROM CitasPacientes WHERE clinica_id IN (?) AND inicio >= ?)', [clinicIds, localToUtc(`${start}T00:00:00`).replace('T', ' ').replace('Z', '')]);
    const [patients] = await connection.query('SELECT p.id_paciente, p.clinica_id, p.nombre, p.apellidos, p.email, p.telefono_movil, p.dni, p.fecha_nacimiento FROM Pacientes p WHERE p.clinica_id IN (?) OR EXISTS (SELECT 1 FROM PacienteClinicas pc WHERE pc.paciente_id = p.id_paciente AND pc.clinica_id IN (?)) ORDER BY p.id_paciente', [clinicIds, clinicIds]);
    const byPatient = index(links, (r) => String(r.paciente_id));
    const rawByPatient = index(rawIdentities, (r) => String(r.paciente_id));
    const treatmentNames = new Map(treatments.map((r) => [r.id_tratamiento, norm(r.nombre)]));
    const metadataOf = (r) => typeof r.import_metadata === 'string' ? JSON.parse(r.import_metadata) : r.import_metadata || {};
    const resourceAgendas = new Map();
    for (const row of rows) {
      if (row.source_system !== 'cliniccloud' || !row.doctor_id || !row.instalacion_id) continue;
      const agenda = norm(agendaIds.get(String(metadataOf(row).source_agenda_id))?.[0]?.values.nombre);
      if (!agenda) continue;
      const key = `${row.clinica_id}:${row.doctor_id}:${row.instalacion_id}`;
      if (!resourceAgendas.has(key)) resourceAgendas.set(key, new Set());
      resourceAgendas.get(key).add(agenda);
    }
    snapshot = {
      version: 1, source_account: options['--source-account'], captured_at: new Date().toISOString(), database_group_id: clinics[0].grupoClinicaId,
      complete_for: { clinic_ids: clinicIds, start, end, all_later_appointments_included: true },
      patients: patients.map((p) => ({ id: p.id_paciente, clinic_id: p.clinica_id, source_contact_ids: [...new Set([...(byPatient.get(String(p.id_paciente)) || []).map((r) => String(r.value).trim()), ...(rawByPatient.get(String(p.id_paciente)) || []).map((r) => r.source_contact_id).filter((v) => v && v !== 'null')])], source_history_numbers: [...new Set((rawByPatient.get(String(p.id_paciente)) || []).map((r) => r.history_number).filter((v) => v && v !== 'null'))], fields: { name: p.nombre || '', surname: p.apellidos || '', email: p.email || '', phone: p.telefono_movil || '', national_id: p.dni || '', birth_date: dateOnly(p.fecha_nacimiento) || '' } })),
      appointments: rows.map((r) => {
        const metadata = metadataOf(r);
        const baseline = metadata.raw ? normalizeAppointments([{ source_row: 0, values: metadata.raw }], 'historic_db_metadata', { historical: true, agendas, services, serviceTypes })[0] : null;
        const sourceAgenda = norm(agendaIds.get(String(metadata.source_agenda_id))?.[0]?.values.nombre);
        const resources = resourceAgendas.get(`${r.clinica_id}:${r.doctor_id}:${r.instalacion_id}`);
        const mappedAgenda = !sourceAgenda && !r.source_system && resources?.size === 1 ? [...resources][0] : '';
        return { id: r.id_cita, patient_id: r.paciente_id, clinic_id: r.clinica_id, kind: 'appointment', source_system: r.source_system, source_reference: r.source_reference, source_external_id: metadata.source_appointment_id || null, source_contact_id: metadata.source_contact_id || null,
          start_local: utcToLocal(`${r.inicio.replace(' ', 'T')}Z`), end_local: utcToLocal(`${r.fin.replace(' ', 'T')}Z`), status: r.estado,
          agenda_key: sourceAgenda || mappedAgenda, agenda_evidence: sourceAgenda ? 'historic_source_agenda_id' : mappedAgenda ? 'unique_same_clinic_doctor_and_installation' : null, service_key: norm(serviceIds.get(String(metadata.source_service_id))?.[0]?.values.nombre) || treatmentNames.get(r.tratamiento_id) || '',
          doctor_id: r.doctor_id, installation_id: r.instalacion_id, treatment_id: r.tratamiento_id, updated_at: r.updated_at,
          last_imported: baseline ? { start_local: baseline.start_local, end_local: baseline.end_local, status: baseline.status, agenda_key: baseline.agenda_key } : null,
        };
      }),
    };
    await connection.rollback();
  } finally { await connection.end(); }
  writePrivateJson(options['--private-output'], snapshot);
  return { mode: 'read_only_snapshot', clinic_count: clinicIds.length, patients: snapshot.patients.length, appointments: snapshot.appointments.length, snapshot_sha256: hash(snapshot), captured_at: snapshot.captured_at };
}
if (require.main === module) run(process.argv.slice(2)).then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`${/^[A-Z][A-Z0-9_:]+$/.test(error.message) ? error.message : 'CLINICCLOUD_SNAPSHOT_FAILED'}\n`);
  process.exitCode = 1;
});
module.exports = { run };
