#!/usr/bin/env node
'use strict';

// Persistent, explicitly fictitious DEV data. Never copies CRM or authenticates
// a user; all existing rows are preserved, including edits to previous fixtures.
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const KEY = 'dev-clinical-workspace-v1';
const CLINIC_NAME = 'Clínica multiárea · DEMO';
const NOTE = 'Datos ficticios para pruebas. No corresponde a una persona ni a una atención real.';
const AREAS = Object.freeze([
  ['estetica', 'Consulta estética', 45, 90],
  ['capilar', 'Consulta capilar', 30, 75],
  ['nutricion', 'Consulta nutricional', 45, 60],
  ['psicologia', 'Consulta de psicología', 60, 70],
  ['dental', 'Revisión dental', 30, 50],
  ['general', 'Consulta general', 30, 55],
]);
const json = value => typeof value === 'string' ? JSON.parse(value) : value;

function assertEnvironment(env) {
  assert.equal(env.QA_DEV_WORKSPACE_WRITES, KEY, 'Explicit fixture opt-in required');
  assert.equal(env.DB_NAME, 'clinicaclick_dev_isolated', 'Only isolated DEV is supported');
  assert.equal(env.DB_USERNAME, 'cc_dev_api', 'Only the restricted DEV SQL user is supported');
  assert(['127.0.0.1', 'localhost'].includes(env.DB_HOST));
  assert(!env.DATABASE_URL && !env.DB_URL, 'Do not override the isolated connection');
}

function buildPlan(monday) {
  assert(/^\d{4}-\d{2}-\d{2}$/.test(monday || ''), 'Pass an explicit ISO Monday');
  const date = DateTime.fromISO(monday, { zone: 'Europe/Madrid' });
  assert(date.isValid && date.toISODate() === monday && date.weekday === 1, 'Pass an explicit ISO Monday');
  const patients = Array.from({ length: 24 }, (_, i) => ({
    public_id: `pac_demo_multi_v1_${String(i + 1).padStart(2, '0')}`,
    nombre: `Paciente DEMO ${String(i + 1).padStart(2, '0')}`,
    apellidos: AREAS[i % AREAS.length][1],
    antecedentes: NOTE, idioma_preferido: 'es', paciente_conocido: true,
    telefono_movil: null, telefono_secundario: null, email: null, dni: null,
  }));
  const appointments = patients.flatMap((patient, i) => [-7, 0].map(offset => {
    const start = date.plus({ days: offset + i % 5 }).set({ hour: [10, 11, 12, 16, 17][Math.floor(i / 5)] });
    return { patientIndex: i, areaIndex: i % AREAS.length,
      source_reference: `${KEY}:${monday}:${i}:${offset === 0 ? 'next' : 'past'}`,
      inicio: start.toUTC().toISO(), fin: start.plus({ minutes: AREAS[i % AREAS.length][2] }).toUTC().toISO(),
      estado: offset === 0 ? 'pendiente' : 'completada',
      tipo_cita: offset === 0 ? 'revision' : 'primera_con_trat',
      titulo: `DEMO · ${AREAS[i % AREAS.length][1]}`, nota: NOTE,
      source_system: 'clinicaclick_demo',
      import_metadata: { qa_demo: KEY, synthetic_data_only: true, automation_policy: 'hold',
        notification_suppression: { appointment_details: true, day_before: true, same_day: true } },
    };
  }));
  return { monday, patients, appointments };
}

async function seed({ db, plan, transaction, book, initializeClinic }) {
  assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
  assert.equal(db.sequelize.config.username, 'cc_dev_api');
  assert.equal(transaction.options.isolationLevel, 'READ COMMITTED');
  // Stable anchor also serializes concurrent first runs before our clinic exists.
  const anchor = await db.Clinica.findByPk(1, { transaction, lock: transaction.LOCK.UPDATE });
  assert.equal(anchor?.nombre_clinica, 'Clinica ficticia DEV');
  const actor = await db.Usuario.findByPk(1, { transaction, lock: transaction.LOCK.SHARE });
  assert.equal(actor?.email_usuario, 'carlos@clinicaclick.com');
  const created = {}, preserved = {}; let existingWorkspace = false;
  async function ensure(model, where, defaults, verify) {
    let row = await db[model].findOne({ where, transaction });
    if (row) { verify?.(row); preserved[model] = (preserved[model] || 0) + 1; }
    else {
      assert(!existingWorkspace, `Existing workspace ${model} changed or removed; review instead of recreating it`);
      row = await db[model].create({ ...where, ...defaults }, { transaction, hooks: false }); created[model] = (created[model] || 0) + 1;
    }
    return row;
  }
  const clinic = await ensure('Clinica', { nombre_clinica: CLINIC_NAME }, {
    estado_clinica: true, descripcion: NOTE,
    configuracion: { timezone: 'Europe/Madrid', disciplinas: AREAS.map(a => a[0]),
      qa_demo: { key: KEY, synthetic_data_only: true } },
  }, row => assert.equal(json(row.configuracion)?.qa_demo?.key, KEY));
  const clinicId = clinic.id_clinica;
  existingWorkspace = !created.Clinica;
  if (created.Clinica) await initializeClinic(clinicId, { actorId: actor.id_usuario, transaction });
  else assert(await db.ClinicMedicalAreaContract.count({ where: { clinic_id: clinicId }, transaction }), 'Do not repair existing area assignments silently');
  await ensure('UsuarioClinica', { id_usuario: actor.id_usuario, id_clinica: clinicId },
    { rol_clinica: 'propietario', estado_invitacion: 'aceptada' });
  async function hours(model, where) {
    for (let dia_semana = 1; dia_semana <= 5; dia_semana++) await ensure(model,
      { ...where, dia_semana, hora_inicio: '09:00', hora_fin: '20:00' }, { activo: true });
  }
  // Only initialize hours for newly created resources. A replay must not undo a
  // user's narrowed/removed opening hours or re-enable staff membership.
  if (created.Clinica) await hours('ClinicaHorario', { clinica_id: clinicId });
  const doctors = [], rooms = [];
  for (let i = 0; i < 2; i++) {
    const user = await ensure('Usuario', { email_usuario: `dev.multi.v1.${i}@example.invalid` }, {
      nombre: `Profesional DEMO ${i + 1}`, apellidos: 'Ficticio', isProfesional: true,
      notas_usuario: KEY, password_usuario: null,
    }, row => assert.equal(row.notas_usuario, KEY));
    const previousLinks = created.DoctorClinica || 0;
    const membership = await ensure('DoctorClinica', { doctor_id: user.id_usuario, clinica_id: clinicId },
      { rol_en_clinica: 'Doctores', activo: true, recibe_citas: true });
    await ensure('UsuarioClinica', { id_usuario: user.id_usuario, id_clinica: clinicId },
      { rol_clinica: 'personaldeclinica', subrol_clinica: 'Doctores', estado_invitacion: 'aceptada' });
    if ((created.DoctorClinica || 0) > previousLinks) await hours('DoctorHorario', { doctor_clinica_id: membership.id });
    const previousRooms = created.Instalacion || 0;
    const room = await ensure('Instalacion', { clinica_id: clinicId, nombre: `Consulta DEMO ${i + 1}` }, {
      descripcion: KEY, capacidad: 1, activo: true, tipo: 'consulta', color: i ? '#0d9488' : '#4f46e5',
      profesionales_permitidos: [user.id_usuario],
    }, row => assert.equal(row.descripcion, KEY));
    if ((created.Instalacion || 0) > previousRooms) await hours('InstalacionHorario', { instalacion_id: room.id });
    doctors.push(user.id_usuario); rooms.push(room.id);
  }
  const treatments = [];
  for (const [i, [area, label, duration, amount]] of AREAS.entries()) {
    const row = await ensure('Tratamiento', { clinica_id: clinicId, codigo: `DEMO-MULTI-V1-${area}` }, {
      nombre: `DEMO · ${label}`, descripcion: NOTE, disciplina: area, categoria: 'Demostración',
      origen: 'clinica', activo: true, duracion_min: duration, precio_base: amount,
      clinical_config: { qa_demo: KEY, catalog_status: 'active',
        price_profile: { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 21, exemption_reason: null },
        booking_profile: { version: 1, phases: [{ key: 'consultation', label, duration_minutes: duration,
          installation_ids: [rooms[i % 2]], professionals: { mode: 'any', ids: [doctors[i % 2]], preferred_id: doctors[i % 2] } }] } },
    }, row => assert.equal(json(row.clinical_config)?.qa_demo, KEY));
    treatments.push(row.id_tratamiento);
  }
  const patients = [];
  for (const payload of plan.patients) {
    const patient = await ensure('Paciente', { public_id: payload.public_id }, { ...payload, clinica_id: clinicId },
      row => assert.equal(row.clinica_id, clinicId));
    await ensure('PacienteClinica', { paciente_id: patient.id_paciente, clinica_id: clinicId }, { es_principal: true });
    patients.push(patient.id_paciente);
  }
  for (const { areaIndex, patientIndex, ...payload } of plan.appointments) {
    const existing = await db.CitaPaciente.findOne({ where: { source_system: payload.source_system, source_reference: payload.source_reference }, transaction });
    if (existing) {
      assert.equal(existing.clinica_id, clinicId); assert.equal(existing.paciente_id, patients[patientIndex]);
      assert.equal(json(existing.import_metadata)?.qa_demo, KEY);
      preserved.CitaPaciente = (preserved.CitaPaciente || 0) + 1;
      continue;
    }
    await book({ db, transaction, force: false, capabilities: { simple: true, multi: true, equipment: false },
      appointmentValues: { ...payload, clinica_id: clinicId, paciente_id: patients[patientIndex],
        tratamiento_id: treatments[areaIndex], doctor_id: doctors[areaIndex % 2], instalacion_id: rooms[areaIndex % 2],
        created_by: actor.id_usuario, updated_by: actor.id_usuario },
      persist: ({ values, transaction: tx }) => db.CitaPaciente.create(values, { transaction: tx, hooks: false }),
    });
    created.CitaPaciente = (created.CitaPaciente || 0) + 1;
  }
  return { synthetic_only: true, clinicId, clinicName: CLINIC_NAME, monday: plan.monday, created, preserved };
}

// Independent before/after protection covers ALL old rows, including mutable QA
// fixtures, credentials, area pins, economic documents and consent signatures.
const PROTECTED = ['Clinica', 'Usuario', 'UsuarioClinica', 'DoctorClinica', 'DoctorHorario', 'ClinicaHorario',
  'Instalacion', 'InstalacionHorario', 'Paciente', 'PacienteClinica', 'Tratamiento', 'CitaPaciente',
  'ClinicMedicalAreaContract', 'MedicalAreaContract', 'MedicalAreaContractRevision',
  'EconomicBudget', 'EconomicBudgetVersion', 'PatientVoucher', 'PacienteConsentimiento'];
async function snapshot(db, transaction) {
  const out = {};
  for (const name of PROTECTED) out[name] = await db[name].findAll({ raw: true, transaction });
  return out;
}
function assertPreserved(db, before, after, exact = false) {
  for (const name of PROTECTED) {
    const keys = db[name].primaryKeyAttributes;
    const key = row => JSON.stringify(keys.map(k => row[k]));
    const current = new Map(after[name].map(row => [key(row), JSON.stringify(row)]));
    if (exact) assert.equal(current.size, before[name].length, `Rollback changed ${name}`);
    for (const row of before[name]) assert.equal(current.get(key(row)), JSON.stringify(row), `Existing ${name} changed`);
  }
}

async function main(args) {
  assert.equal(args.length, 2); const [mode, monday] = args;
  assert(['--rehearse', '--apply'].includes(mode));
  const plan = buildPlan(monday);
  require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../../.env'), quiet: true });
  assertEnvironment(process.env);
  const oldLog = console.log; let db;
  try { console.log = () => {}; db = require('../../../models'); } finally { console.log = oldLog; }
  let transaction;
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated');
    assert.equal(db.sequelize.config.username, 'cc_dev_api');
    const before = await snapshot(db);
    transaction = await db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' });
    const result = await seed({ db, plan, transaction,
      book: require('../../services/appointmentBookingCommand.service').mutateAppointmentBooking,
      initializeClinic: require('../../services/medicalAreaContracts.service').createMedicalAreaContractsService(db).initializeClinic });
    assertPreserved(db, before, await snapshot(db, transaction));
    if (mode === '--rehearse') await transaction.rollback(); else await transaction.commit();
    transaction = null;
    assertPreserved(db, before, await snapshot(db), mode === '--rehearse');
    console.log(JSON.stringify({ ...result, committed: mode === '--apply', previous_rows_preserved: true }));
  } finally {
    if (transaction && !transaction.finished) await transaction.rollback();
    await db.sequelize.close();
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ error: error.code || error.name, message: error.message })); process.exitCode = 1;
});
module.exports = { KEY, CLINIC_NAME, AREAS, NOTE, assertEnvironment, buildPlan, seed, assertPreserved, PROTECTED };
