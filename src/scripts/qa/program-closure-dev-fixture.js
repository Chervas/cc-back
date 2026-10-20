#!/usr/bin/env node
'use strict';

// Retained synthetic fixture only. Default mode is READ ONLY. Preparing creates
// a fresh marker-owned offer/purchase, never resets an earlier QA purchase or
// changes a patient's identity, schedules, permissions or existing resources.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { connectOperatorDatabase } = require('../../lib/cliniccloud-import/operator-database');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const MARKER = 'program-closure-20261020';
const CLINIC = 1, PATIENT = 33021, PATIENT_PUBLIC = 'pac_09202026000000000001';
const RESOURCE_MARKER = 'bs-startup-isolated-20260920';
const ROOM_IDS = [73, 74], DOCTOR_IDS = [220, 221];
const GATES = ['TREATMENT_PROGRAM_BOOKING_ENABLED', 'TREATMENT_PROGRAM_ECONOMICS_ENABLED',
  'BOOKING_PROFILES_ENABLED', 'BOOKING_MULTI_RESOURCE_ENABLED'];
const OBSERVED_RUNTIME_KEYS = [...GATES, 'BOOKING_PHASE_OFFSETS_ENABLED', 'JOB_RUNTIME_NAMESPACE', 'JOBS_WORKER_ENABLED', 'JOBS_CRON_LEADER'];

function assertRuntimeGates(flags) {
  for (const key of GATES) assert.equal(flags[key], 'true', 'DEV_PROGRAM_RUNTIME_DISABLED:' + key);
  assert.equal(flags.JOB_RUNTIME_NAMESPACE, 'dev', 'DEV_RUNTIME_NAMESPACE_REQUIRED');
  assert.equal(flags.JOBS_WORKER_ENABLED, 'false', 'DEV_WORKERS_MUST_BE_OFF');
  assert.equal(flags.JOBS_CRON_LEADER, 'false', 'DEV_CRON_MUST_BE_OFF');
  assert(flags.BOOKING_PHASE_OFFSETS_ENABLED == null || ['true', 'false'].includes(flags.BOOKING_PHASE_OFFSETS_ENABLED), 'DEV_RELATIVE_GATE_INVALID');
}
function applyObservedRuntimeGates(flags, environment) {
  assertRuntimeGates(flags);
  // This short-lived operator reproduces the already-running DEV API's exact
  // whitelisted switches. It neither changes the API/worker configuration nor
  // invents an enabled gate from an older .env default. Secrets are excluded.
  for (const key of OBSERVED_RUNTIME_KEYS) {
    if (Object.hasOwn(flags, key)) environment[key] = flags[key];
    else delete environment[key];
  }
}
function readRuntimeGates() {
  const pid = execFileSync('systemctl', ['show', 'clinicaclick-back-dev.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
  assert(/^[1-9]\d*$/.test(pid), 'DEV_API_NOT_RUNNING');
  const keys = OBSERVED_RUNTIME_KEYS;
  const select = value => Object.fromEntries(value.split('\0').flatMap(raw => {
    const at = raw.indexOf('='); return keys.includes(raw.slice(0, at)) ? [[raw.slice(0, at), raw.slice(at + 1)]] : [];
  }));
  try { return select(fs.readFileSync(`/proc/${pid}/environ`, 'utf8')); }
  catch (error) {
    if (error.code !== 'EACCES') throw error;
    // Only these non-secret operational switches are returned. No environment
    // dump or credentials are passed to the operator's output or child argv.
    const code = `const f=require('node:fs'),k=${JSON.stringify(keys)};const out={};for(const r of f.readFileSync('/proc/${pid}/environ','utf8').split('\\0')){const a=r.indexOf('=');if(k.includes(r.slice(0,a)))out[r.slice(0,a)]=r.slice(a+1)}process.stdout.write(JSON.stringify(out));`;
    return JSON.parse(execFileSync('sudo', ['-n', process.execPath, '-e', code], { encoding: 'utf8' }));
  }
}
function validateScope(report) {
  assert.equal(report.clinic?.id_clinica, CLINIC); assert.equal(report.clinic?.nombre_clinica, 'Clinica ficticia DEV');
  assert.equal(report.patient?.id_paciente, PATIENT); assert.equal(report.patient?.public_id, PATIENT_PUBLIC);
  assert.equal(report.patient?.clinica_id, CLINIC); assert.equal(report.actor?.id_usuario, 1);
  assert.equal(report.actor?.email_usuario, 'carlos@clinicaclick.com');
  assert.deepEqual(report.rooms.map(row => row.id).sort((a, b) => a - b), ROOM_IDS);
  assert.deepEqual(report.doctors.map(row => row.doctor_id).sort((a, b) => a - b), DOCTOR_IDS);
  for (const room of report.rooms) { assert.equal(room.clinica_id, CLINIC); assert.equal(room.activo, 1); assert.equal(room.descripcion, RESOURCE_MARKER); }
  for (const doctor of report.doctors) {
    assert.equal(doctor.clinica_id, CLINIC); assert.equal(doctor.activo, 1); assert.equal(doctor.recibe_citas, 1);
    assert.equal(doctor.notas_usuario, RESOURCE_MARKER);
  }
  const { installationAllowsStaff } = require('../../lib/installation-professionals');
  ROOM_IDS.forEach((roomId, index) => assert(installationAllowsStaff(report.rooms.find(row => row.id === roomId), [DOCTOR_IDS[index]]), 'SYNTHETIC_ROOM_PERMISSION_CHANGED'));
  assertRuntimeGates(report.runtime_gates);
  return true;
}

async function inspect() {
  const c = await connectOperatorDatabase('dev');
  try {
    await c.query('START TRANSACTION READ ONLY');
    const one = async (sql, args) => (await c.query(sql, args))[0][0] || null;
    const clinic = await one('SELECT id_clinica,nombre_clinica FROM Clinicas WHERE id_clinica=?', [CLINIC]);
    const patient = await one('SELECT id_paciente,public_id,clinica_id FROM Pacientes WHERE id_paciente=? AND public_id=?', [PATIENT, PATIENT_PUBLIC]);
    const actor = await one('SELECT id_usuario,email_usuario FROM Usuarios WHERE id_usuario=1');
    const [rooms] = await c.query('SELECT id,clinica_id,activo,nombre,descripcion,profesionales_permitidos FROM Instalaciones WHERE id IN (?,?) ORDER BY id', ROOM_IDS);
    const [doctors] = await c.query('SELECT dc.doctor_id,dc.clinica_id,dc.activo,dc.recibe_citas,u.notas_usuario FROM DoctorClinicas dc JOIN Usuarios u ON u.id_usuario=dc.doctor_id WHERE dc.clinica_id=? AND dc.doctor_id IN (?,?) ORDER BY dc.doctor_id', [CLINIC, ...DOCTOR_IDS]);
    const [budgets] = await c.query('SELECT public_id,status FROM EconomicBudgets WHERE clinic_id=? AND patient_id=? AND source_reference=?', [CLINIC, PATIENT, MARKER]);
    await c.query('ROLLBACK');
    const report = { marker: MARKER, target: 'dev_isolated', read_only: true, clinic, patient, actor, rooms, doctors,
      runtime_gates: readRuntimeGates(), existing_budgets: budgets,
      intended_changes: { new_patient: false, existing_schedules_or_permissions: false, new_treatments: 2,
        new_program: 1, program_sessions: 3, offsets_days: [0, 15, 30], duration_minutes_per_visit: 60,
        new_budget: 1, accepted_purchase: 1, appointments_created_by_prepare: 0, real_sends: 0, payments_or_invoices: 0 } };
    validateScope(report); return report;
  } finally { await c.end(); }
}

async function prepare({ gateValue = process.env.QA_PROGRAM_CLOSURE_DEV_WRITES } = {}) {
  assert.equal(gateValue, MARKER, 'EXPLICIT_SYNTHETIC_DEV_WRITE_AUTHORIZATION_REQUIRED');
  assert.equal(process.cwd(), '/home/ubuntu/wt/back-dev', 'CURRENT_DEV_WORKTREE_REQUIRED');
  const preflight = await inspect(); validateScope(preflight);
  // Use the configured DEV application models/services; never borrow CRM env
  // or set runtime gates to make a test succeed.
  require('dotenv').config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });
  assert.equal(process.env.DB_NAME, 'clinicaclick_dev_isolated'); assert.equal(process.env.DB_USERNAME, 'cc_dev_api');
  applyObservedRuntimeGates(preflight.runtime_gates, process.env);
  const db = require('../../../models');
  try {
    assert.equal(db.sequelize.config.database, 'clinicaclick_dev_isolated'); assert.equal(db.sequelize.config.username, 'cc_dev_api');
    assert(require('../../lib/program-booking').programBookingEnabled(), 'CONFIGURED_DEV_GATES_MUST_ALREADY_BE_ENABLED');
    const profile = { schema_version: 1, price_semantics: 'gross_tax_included', tax_percent: 0,
      exemption_reason: 'Configuración fiscal ficticia de QA, sin validez real. No emitir.' };
    const treatmentIds = [];
    for (const [index, room] of ROOM_IDS.entries()) {
      const [treatment] = await db.Tratamiento.findOrCreate({ where: { codigo: `QA-PROG-CLOSURE-20261020-${index + 1}`, clinica_id: CLINIC },
        defaults: { nombre: `QA · Cierre de programas · Paso ${index + 1}`, disciplina: 'estetica', origen: 'clinica', activo: true,
          duracion_min: 30, precio_base: 50, sesiones_defecto: 1,
          clinical_config: { qa_demo: MARKER, catalog_status: 'active', price_profile: profile, booking_profile: { version: 1,
            phases: [{ key: 'care', label: `Paso ficticio ${index + 1}`, duration_minutes: 30, installation_ids: [room],
              professionals: { mode: 'any', ids: [DOCTOR_IDS[index]], preferred_id: DOCTOR_IDS[index] } }] } } } });
      assert.equal(treatment.clinical_config.qa_demo, MARKER, 'DO_NOT_OVERWRITE_FOREIGN_TREATMENT');
      assert.equal(treatment.activo, true, 'FIXTURE_TREATMENT_EDIT_REQUIRES_REVIEW');
      assert.equal(hash(treatment.clinical_config.booking_profile), hash({ version: 1, phases: [{ key: 'care',
        label: `Paso ficticio ${index + 1}`, duration_minutes: 30, installation_ids: [room],
        professionals: { mode: 'any', ids: [DOCTOR_IDS[index]], preferred_id: DOCTOR_IDS[index] } }] }), 'FIXTURE_TREATMENT_EDIT_REQUIRES_REVIEW');
      assert.equal(hash(treatment.clinical_config.price_profile), hash(profile), 'FIXTURE_TAX_EDIT_REQUIRES_REVIEW');
      treatmentIds.push(Number(treatment.id_tratamiento));
    }
    const programs = require('../../services/treatmentPrograms.service'), economics = require('../../services/patientEconomics.service');
    const program = await programs.create({ clinicId: CLINIC, actorId: 1, payload: { idempotency_key: MARKER,
      name: 'QA · Programa de 3 citas · Cierre 20/10', kind: 'program', status: 'active', total_price: 150, price_profile: profile,
      notes: `${MARKER}. Compra ficticia de QA: no facturar, enviar ni aplicar a pacientes reales.`,
      appointments: [0, 15, 30].map((offset_days, index) => ({ key: `qa_${index + 1}`, label: `Cita ficticia ${index + 1}`,
        offset_days, treatment_ids: treatmentIds })) } });
    let budget = await db.EconomicBudget.findOne({ where: { clinic_id: CLINIC, patient_id: PATIENT, source_reference: MARKER } });
    if (!budget) {
      const created = await economics.createBudget({ patientIdentifier: PATIENT_PUBLIC, clinicId: CLINIC, actorId: 1,
        payload: { status: 'draft', source_system: 'clinicaclick_demo', source_reference: MARKER,
          notes: `${MARKER}. QA ficticia; no facturar ni enviar.`, payment_proposal: { mode: 'single', included_modes: ['single'] },
          lines: [{ key: 'program', program_id: program.item.id, program_version: program.item.version, quantity: 1, unit_price: 150 }] } });
      budget = await db.EconomicBudget.findOne({ where: { public_id: created.id, clinic_id: CLINIC, patient_id: PATIENT } });
    }
    assert(budget); assert.equal(budget.source_reference, MARKER);
    if (budget.status === 'draft') await economics.transitionBudget({ publicId: budget.public_id, actorId: 1, action: 'present', payload: { presentation_channel: 'printed' } });
    await budget.reload();
    if (budget.status === 'presented') await economics.transitionBudget({ publicId: budget.public_id, actorId: 1, action: 'accept', payload: {
      selected_payment_mode: 'single', signature_channel: 'not_required', send_channel: 'none', collection_method: 'pending' } });
    await budget.reload(); assert.equal(budget.status, 'accepted', 'FIXTURE_HUMAN_EDIT_REQUIRES_REVIEW');
    const voucher = await db.PatientVoucher.findOne({ where: { budget_id: budget.id, clinic_id: CLINIC, patient_id: PATIENT, source_system: 'treatment_program' } });
    assert(voucher);
    const plan = await require('../../services/patientProgramBooking.service').read({ publicId: voucher.public_id, clinicId: CLINIC, actorId: 1 });
    const after = await inspect();
    assert.equal(hash(after.rooms), hash(preflight.rooms), 'EXISTING_ROOMS_CHANGED');
    assert.equal(hash(after.doctors), hash(preflight.doctors), 'EXISTING_DOCTORS_CHANGED');
    return { marker: MARKER, target: 'dev_isolated', synthetic_only: true, clinic_id: CLINIC, patient_id: PATIENT,
      patient_public_id: PATIENT_PUBLIC, program_id: program.item.id, budget_id: budget.public_id, voucher_id: voucher.public_id,
      patient_url: `http://localhost:4203/pacientes/detalle/${PATIENT}/presupuestos?clinica_id=${CLINIC}`,
      session_count: plan.sessions.length, pending_count: plan.pending_count, appointments_created_by_prepare: 0,
      real_sends: 0, existing_resources_unchanged: true };
  } finally { await db.sequelize.close(); }
}

async function main() {
  assert(['--inspect', '--prepare'].includes(process.argv[2]), 'EXPLICIT_INSPECT_OR_PREPARE_MODE_REQUIRED');
  console.log(JSON.stringify(process.argv[2] === '--prepare' ? await prepare() : await inspect(), null, 2));
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ code: error.code || error.name, message: error.message })); process.exitCode = 1; });
module.exports = { MARKER, CLINIC, PATIENT, PATIENT_PUBLIC, ROOM_IDS, DOCTOR_IDS, assertRuntimeGates, applyObservedRuntimeGates, validateScope, inspect, prepare };
