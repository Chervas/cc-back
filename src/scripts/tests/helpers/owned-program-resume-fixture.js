'use strict';

// Own fixtures only: fresh private mysqld/synthetic identities, never models/index,
// app configuration, providers or a purchased patient program from a real DB.
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const S = require('sequelize');
const { createOwnedBookingDurationFixture } = require('./owned-booking-duration-fixture');
const { snapshot, operationalSnapshot } = require('../../../lib/economicProgramSnapshot');
const clone = value => JSON.parse(JSON.stringify(value));
function scopedModule(filename, overrides) {
  const local = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console, Date, Map, Set, Promise, structuredClone,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : local(name) }, { filename });
  return module.exports;
}
async function createOwnedProgramResumeFixture({ sql, models: db }) {
  const physical = await createOwnedBookingDurationFixture({ sql, models: db });
  const D = S.DataTypes;
  for (const file of ['economicbudget', 'economicbudgetversion', 'economicbudgetevent', 'economicpayment', 'patientvoucher',
    'patientvouchermovement', 'patientprogramsession', 'patientprogrambookingrequest', 'patientoperationalevent',
    'patientconsentdocument', 'consentsignaturepackage', 'consentdeliveryevent']) {
    const model = require('../../../../models/' + file)(sql, D); db[model.name] = model;
  }
  db.PatientOperationalEvent.associate?.(db);
  const define = (name, fields) => db[name] = sql.define(name, fields, { timestamps: false });
  for (const name of ['ClinicConsentTemplate', 'ConsentTemplateCatalog']) define(name, {
    id: { type: D.INTEGER, primaryKey: true }, purpose: D.STRING, status: D.STRING, validity_mode: D.STRING, requires_professional_signature: D.BOOLEAN });
  define('TreatmentConsentRequirement', { id: { type: D.INTEGER, primaryKey: true }, tratamiento_id: D.INTEGER, clinica_id: D.INTEGER,
    required: D.BOOLEAN, blocking_policy: D.STRING, clinic_template_id: D.INTEGER, catalog_template_id: D.INTEGER });
  db.TreatmentConsentRequirement.belongsTo(db.ClinicConsentTemplate, { foreignKey: 'clinic_template_id', as: 'clinicTemplate' });
  db.TreatmentConsentRequirement.belongsTo(db.ConsentTemplateCatalog, { foreignKey: 'catalog_template_id', as: 'catalogTemplate' });
  // Production uses migrations with explicit names, not factory sync. Only
  // shorten an overlong generated name in this owned fixture; physical indexes
  // already created by the reused helper are left exactly as they were.
  for (const model of Object.values(sql.models)) (model.options.indexes || []).forEach((index, i) => {
    if (!index.name || index.name.length > 64) index.name = `qa_resume_${model.name.slice(0, 30)}_${i}`;
  });
  // Only tables in the owned, previously empty fixture are synced.
  await sql.sync();
  await db.Usuario.create({ id_usuario: 3, nombre: 'Profesional ficticio 3' });
  const member = await db.DoctorClinica.create({ doctor_id: 3, clinica_id: 100, recibe_citas: true });
  await db.Instalacion.create({ id: 103, clinica_id: 100, nombre: 'Sala independiente ficticia', profesionales_permitidos: [3], activo: true });
  await db.BookingEquipmentRoomPolicy.create({ installation_id: 103, mode: 'none', equipment_ids: [] });
  for (let day = 1; day <= 5; day++) {
    await db.DoctorHorario.create({ doctor_clinica_id: member.id, dia_semana: day, hora_inicio: '09:00', hora_fin: '20:00' });
    await db.InstalacionHorario.create({ instalacion_id: 103, dia_semana: day, hora_inicio: '09:00', hora_fin: '20:00' });
  }
  const profile = { version: 4, phases: [
    { key: 'one', label: 'Paso inicial ficticio', start_offset_minutes: 0, duration_minutes: 30, installation_ids: [101],
      professionals: { mode: 'any', ids: [1], preferred_id: 1 }, equipment_requirements: [{ equipment_ids: [401] }] },
    { key: 'two', label: 'Paso final ficticio', start_offset_minutes: 15, duration_minutes: 30, installation_ids: [102],
      professionals: { mode: 'any', ids: [2], preferred_id: 2 } },
  ] };
  const single = (installation, doctor, machine = false) => ({ version: machine ? 2 : 1, phases: [{ key: 'peer', label: 'Paso ajeno ficticio',
    duration_minutes: 30, installation_ids: [installation], professionals: { mode: 'any', ids: [doctor], preferred_id: doctor },
    ...(machine ? { equipment_requirements: [{ equipment_ids: [401] }] } : {}) }] });
  await db.Tratamiento.bulkCreate([[30, 100, profile], [31, 200, single(201, 2)], [32, 100, single(103, 3)], [33, 100, single(102, 2, true)]]
    .map(([id_tratamiento, clinica_id, booking_profile]) => ({ id_tratamiento, clinica_id, grupo_clinica_id: 50, origen: 'clinica', activo: true,
      nombre: 'Tratamiento ficticio ' + id_tratamiento, clinical_config: { catalog_status: 'active', booking_profile } })));
  const frozen = snapshot({ id: 'owned-selected-resume', version: 1, status: 'active', kind: 'program', name: 'Programa sintético de cinco sesiones',
    total_price: 121, summary: { issues: [] }, appointments: Array.from({ length: 5 }, (_, position) => ({ key: 's' + position, label: 'Sesión ' + (position + 1),
      offset_days: null, treatment_ids: [30], duration_minutes: 45, treatments: [{ id: 30, name: 'Combinado ficticio', booking_profile: profile }] })) });
  const budget = await db.EconomicBudget.create({ public_id: 'owned-resume-budget', clinic_id: 100, patient_id: 1, number: 'OWNED-QA', status: 'accepted' });
  await db.EconomicBudgetVersion.create({ budget_id: budget.id, version_number: 1, lines: [{ key: 'line', program_snapshot: frozen }],
    totals: { total: 121 }, payment_proposal: {}, design_config: {}, clinic_snapshot: {}, patient_snapshot: {} });
  const voucher = await db.PatientVoucher.create({ public_id: 'owned-resume-voucher', clinic_id: 100, patient_id: 1, budget_id: budget.id,
    budget_line_key: 'line', name: frozen.name, total_units: 5, available_units: 5, sold_amount: 121, status: 'active', source_system: 'treatment_program' });
  const serviceFile = require.resolve('../../../services/patientProgramBooking.service');
  const local = createRequire(serviceFile), program = local('../lib/program-booking'), availability = local('./appointmentBookingAvailability.service');
  // Only environment capability lookups are scoped for the test. SQL loaders,
  // resource locks, solver, command, receipts, activities and transactions stay real.
  const command = scopedModule(local.resolve('./appointmentBookingCommand.service'), { '../lib/program-booking': { ...program, programBookingEnabled: () => true } });
  const loaded = scopedModule(serviceFile, { './appointmentBookingCommand.service': command,
    './appointmentBookingAvailability.service': { ...availability, loadBookingContext: args => availability.loadBookingContext({ ...args, equipmentEnabled: true }) } });
  let clock = new Date('2030-01-01T00:00:00Z');
  const service = loaded.createPatientProgramBookingService({ db, enabled: () => true, capabilities: () => physical.capabilities, now: () => new Date(clock) });
  const options = { publicId: voucher.public_id, clinicId: 100, actorId: 1 };
  const tables = ['CitaPaciente', 'AppointmentBookingOccupancy', 'AppointmentBookingResource', 'PatientProgramSession', 'PatientProgramBookingRequest',
    'PatientVoucher', 'PatientVoucherMovement', 'EconomicBudget', 'EconomicBudgetVersion', 'EconomicPayment', 'PatientOperationalEvent', 'ConsentDeliveryEvent'];
  const all = async name => clone(await db[name].findAll({ order: [[db[name].primaryKeyAttribute, 'ASC']], raw: true }));
  const databaseState = async () => Object.fromEntries(await Promise.all(tables.map(async name => [name, await all(name)])));
  const selections = solution => Object.fromEntries(solution.phases.map(phase => [phase.key, { installation_id: phase.installation_id,
    ...(phase.doctor_ids.length === 1 ? { doctor_id: phase.doctor_ids[0] } : {}) }]));
  const propose = payload => service.propose({ ...options, payload });
  const read = () => service.read(options);
  const resume = async key => ({ mode: 'resume', replan_from_key: key, expected_plan_revision: (await read()).plan_revision });
  const book = payload => service.book({ ...options, payload: { snapshot_sha256: frozen.sha256, ...payload } });
  const byKey = async key => db.PatientProgramSession.findOne({ where: { voucher_id: voucher.id, session_key: key } });
  const appointment = async key => { const record = await byKey(key); return record?.appointment_id ? db.CitaPaciente.findByPk(record.appointment_id) : null; };
  const peer = async (kind, start, patientId = 2) => {
    const details = kind === 'alias' ? { clinica_id: 200, tratamiento_id: 31, doctor_id: 2, instalacion_id: 201 }
      : kind === 'machine' ? { clinica_id: 100, tratamiento_id: 33, doctor_id: 2, instalacion_id: 102 }
        : { clinica_id: 100, tratamiento_id: 32, doctor_id: 3, instalacion_id: 103 };
    return physical.reserve({ appointmentValues: physical.values({ ...details, paciente_id: patientId, inicio: start,
      fin: new Date(new Date(start).getTime() + 30 * 60000).toISOString() }) });
  };
  return { db, sql, frozen, profile, operational: operationalSnapshot(frozen), voucher, budget, service, options, all, databaseState,
    read, propose, resume, book, byKey, appointment, selections, peer, physical, advance: instant => { clock = new Date(instant); },
    move: (id, start, end) => command.mutateAppointmentBooking({ db, capabilities: physical.capabilities, existingAppointmentId: id,
      appointmentValues: { inicio: start, fin: end, updated_by: 1 },
      persist: ({ values, existing, transaction }) => existing.update(values, { transaction }) }),
    cancelPeer: row => physical.reserve({ existingAppointmentId: row.id_cita, appointmentValues: { estado: 'cancelada' } }) };
}
module.exports = { createOwnedProgramResumeFixture };
