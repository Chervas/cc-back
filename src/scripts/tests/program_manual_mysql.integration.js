'use strict';

// Explicit opt-in, synthetic data only. The fixture owns its private mysqld,
// datadir and Unix socket; all application DB/TCP/provider/queue access is denied.
// Run: CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/program_manual_mysql.integration.js
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { snapshot } = require('../../lib/economicProgramSnapshot');
const { importReviewVersion } = require('../../lib/appointment-import-review');
const { createPatientProgramBookingService } = require('../../services/patientProgramBooking.service');
const { mutateAppointmentBooking } = require('../../services/appointmentBookingCommand.service');

withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  const D = Sequelize.DataTypes;
  db.Sequelize = Sequelize;
  Object.assign(process.env, {
    TREATMENT_PROGRAM_BOOKING_ENABLED: 'true', TREATMENT_PROGRAM_ECONOMICS_ENABLED: 'true',
    BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true', BOOKING_EQUIPMENT_ENABLED: 'true',
  });
  const define = (name, fields) => db[name] = sql.define(name, fields, { timestamps: false });
  define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER,
    configuracion: D.JSON, equipment_booking_enabled: D.BOOLEAN });
  define('Usuario', { id_usuario: { type: D.INTEGER, primaryKey: true }, nombre: D.STRING, apellidos: D.STRING });
  define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true } });
  define('Tratamiento', { id_tratamiento: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER,
    origen: D.STRING, activo: D.BOOLEAN, clinical_config: D.JSON });
  for (const file of ['doctorclinica', 'doctorhorario', 'doctorhorarioexcepcion', 'doctorbloqueo', 'doctorbloqueoexcepcion',
    'instalacion', 'instalacionhorario', 'instalacionbloqueo', 'clinicahorario', 'citapaciente', 'appointmentbookingoccupancy',
    'appointmentbookingresource', 'installationphysicalalias', 'bookingequipment', 'bookingequipmentclinic',
    'bookingequipmentroompolicy', 'economicbudget', 'economicbudgetversion', 'economicbudgetevent', 'economicpayment',
    'patientvoucher', 'patientvouchermovement', 'patientprogramsession', 'patientprogrambookingrequest',
    'patientoperationalevent', 'patientconsentdocument', 'consentsignaturepackage', 'consentdeliveryevent']) {
    const model = require('../../../models/' + file)(sql, D);
    db[model.name] = model;
  }
  for (const name of ['DoctorClinica', 'DoctorHorario', 'DoctorHorarioExcepcion', 'DoctorBloqueo', 'DoctorBloqueoExcepcion',
    'Instalacion', 'InstalacionHorario', 'InstalacionBloqueo', 'ClinicaHorario', 'CitaPaciente',
    'AppointmentBookingOccupancy', 'BookingEquipment', 'PatientOperationalEvent']) db[name].associate?.(db);
  for (const name of ['ClinicConsentTemplate', 'ConsentTemplateCatalog']) define(name, {
    id: { type: D.INTEGER, primaryKey: true }, purpose: D.STRING, status: D.STRING,
    validity_mode: D.STRING, requires_professional_signature: D.BOOLEAN,
  });
  define('TreatmentConsentRequirement', { id: { type: D.INTEGER, primaryKey: true }, tratamiento_id: D.INTEGER,
    clinica_id: D.INTEGER, required: D.BOOLEAN, blocking_policy: D.STRING,
    clinic_template_id: D.INTEGER, catalog_template_id: D.INTEGER });
  db.TreatmentConsentRequirement.belongsTo(db.ClinicConsentTemplate, { foreignKey: 'clinic_template_id', as: 'clinicTemplate' });
  db.TreatmentConsentRequirement.belongsTo(db.ConsentTemplateCatalog, { foreignKey: 'catalog_template_id', as: 'catalogTemplate' });
  // Only this owned, empty fixture uses sync. Production schema is never synced.
  for (const model of Object.values(sql.models)) (model.options.indexes || []).forEach((index, i) => {
    index.name = `qa_${model.name.slice(0, 35)}_${i}`;
  });
  await sql.sync();
  await db.Clinica.create({ id_clinica: 1, grupoClinicaId: 1, configuracion: { timezone: 'Europe/Madrid' }, equipment_booking_enabled: true });
  for (const id of [1, 2]) await db.Paciente.create({ id_paciente: id });
  await db.Usuario.create({ id_usuario: 1, nombre: 'Profesional ficticio' });
  const member = await db.DoctorClinica.create({ doctor_id: 1, clinica_id: 1, recibe_citas: true });
  await db.Instalacion.create({ id: 1, clinica_id: 1, nombre: 'Consulta ficticia', profesionales_permitidos: [1] });
  for (let day = 1; day <= 5; day++) {
    await db.DoctorHorario.create({ doctor_clinica_id: member.id, dia_semana: day, hora_inicio: '09:00', hora_fin: '20:00' });
    await db.InstalacionHorario.create({ instalacion_id: 1, dia_semana: day, hora_inicio: '09:00', hora_fin: '20:00' });
  }
  const profile = duration => ({ version: 1, phases: [{ key: 'care', label: 'Sesión ficticia', duration_minutes: duration,
    installation_ids: [1], professionals: { mode: 'any', ids: [1], preferred_id: 1 } }] });
  for (const [id, duration] of [[1, null], [2, 30]]) await db.Tratamiento.create({ id_tratamiento: id,
    clinica_id: 1, origen: 'clinica', activo: true, clinical_config: { catalog_status: 'active', booking_profile: profile(duration) } });
  const makePurchase = async (suffix, treatmentId, duration, offsets = [null, null, null]) => {
    const frozen = snapshot({ id: 'qa-manual-' + suffix, version: 1, status: 'active', kind: 'program',
      name: 'Programa ficticio ' + suffix, total_price: 120, summary: { issues: [] },
      appointments: offsets.map((offset_days, index) => ({ key: 's' + index, label: 'Sesión ' + (index + 1),
        offset_days, treatment_ids: [treatmentId], duration_minutes: duration,
        treatments: [{ id: treatmentId, name: 'Tratamiento ficticio', duration_minutes: duration, booking_profile: profile(duration) }] })) });
    const budget = await db.EconomicBudget.create({ public_id: 'qa-budget-' + suffix, clinic_id: 1,
      patient_id: 1, number: 'QA-' + suffix, status: 'accepted' });
    await db.EconomicBudgetVersion.create({ budget_id: budget.id, version_number: 1,
      lines: [{ key: 'line', program_snapshot: frozen }], totals: {}, payment_proposal: {},
      design_config: {}, clinic_snapshot: {}, patient_snapshot: {} });
    const voucher = await db.PatientVoucher.create({ public_id: 'qa-voucher-' + suffix, clinic_id: 1, patient_id: 1,
      budget_id: budget.id, budget_line_key: 'line', name: 'Programa ficticio ' + suffix, total_units: offsets.length,
      available_units: offsets.length, sold_amount: 120, status: 'active', source_system: 'treatment_program' });
    return { frozen, voucher, options: { publicId: voucher.public_id, clinicId: 1, actorId: 1 } };
  };
  const service = createPatientProgramBookingService({ db, now: () => new Date('2030-01-01T00:00:00Z') });
  const counts = async () => Object.fromEntries(await Promise.all([
    'CitaPaciente', 'AppointmentBookingOccupancy', 'PatientProgramSession', 'PatientProgramBookingRequest',
    'PatientVoucherMovement', 'EconomicPayment', 'PatientOperationalEvent', 'ConsentDeliveryEvent',
  ].map(async name => [name, await db[name].count()])));
  const manual = await makePurchase('missing-duration', 1, null);
  let plan = await service.read(manual.options);
  assert.equal(plan.scheduling_mode, 'manual');
  assert.equal(plan.pending_count, 3);
  assert(plan.sessions.every(row => row.start_at === null && row.duration_required));
  const empty = await service.propose({ ...manual.options, payload: { from_date: '2030-01-07', days: 1 } });
  assert(empty.proposals.every(row => row.solution === null && row.reason_code === 'program_manual_date_required'));
  assert.equal(await db.CitaPaciente.count(), 0);
  report.checks.push('real SQL manual read/proposal leaves every remaining date NULL; no automatic appointment created');
  await assert.rejects(service.propose({ ...manual.options, payload: { from_date: '2030-01-07', days: 1,
    session_keys: ['s0'], manual_sessions: [{ key: 's0', start_local: '2030-01-07T10:15' }] } }), { code: 'program_duration_required' });
  const preview = await service.propose({ ...manual.options, payload: { from_date: '2030-01-07', days: 1,
    session_keys: ['s0'], manual_sessions: [{ key: 's0', start_local: '2030-01-07T10:15', duration_minutes: 40 }] } });
  const solution = preview.proposals[0].solution;
  assert.equal(solution.start_at, '2030-01-07T09:15:00.000Z');
  const choice = { key: 's0', start_at: solution.start_at, duration_minutes: 40,
    selections: Object.fromEntries(solution.phases.map(row => [row.key, { installation_id: row.installation_id, doctor_id: row.doctor_ids[0] }])) };
  const request = { request_key: 'qa-manual-booking', snapshot_sha256: manual.frozen.sha256, sessions: [choice] };
  const result = await service.book({ ...manual.options, payload: request });
  assert.equal(result.sessions.length, 1);
  const created = await db.CitaPaciente.findByPk(result.sessions[0].appointment_id);
  assert.equal(new Date(created.inicio).toISOString(), solution.start_at);
  assert.equal(new Date(created.fin) - new Date(created.inicio), 40 * 60000);
  assert.equal(created.estado, 'pendiente');
  assert.equal(created.import_metadata.automation_policy, 'hold');
  assert.equal(created.import_metadata.notification_suppression.appointment_details, true);
  const occupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: created.id_cita } });
  assert(occupancy.some(row => row.resource_kind === 'doctor' && Number(row.doctor_id) === 1));
  assert(occupancy.some(row => row.resource_kind === 'installation' && row.resource_key === 'installation:1'));
  assert(occupancy.every(row => new Date(row.start_at) >= created.inicio && new Date(row.end_at) <= created.fin));
  plan = await service.read(manual.options);
  assert.equal(plan.sessions[0].duration_minutes, 40);
  assert.equal(plan.pending_count, 2);
  assert(plan.sessions.slice(1).every(row => row.start_at === null && row.scheduling_status === 'pending'));
  assert.equal(manual.frozen.appointments[0].duration_minutes, null);
  assert.equal(Number((await manual.voucher.reload()).available_units), 3);
  assert.equal(Number(manual.voucher.sold_amount), 120);
  report.checks.push('canonical ORM booking reserves exact local instant and explicit duration with doctor/room occupancy; others stay pending and units unchanged');
  const bookedCounts = await counts();
  const replay = await service.book({ ...manual.options, payload: request });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.sessions, result.sessions);
  assert.deepEqual(await counts(), bookedCounts);
  await assert.rejects(service.book({ ...manual.options, payload: { ...request,
    sessions: [{ ...choice, duration_minutes: 45 }] } }), { code: 'program_booking_request_conflict' });
  report.checks.push('real SQL booking replay is idempotent; the same request key cannot change its duration');
  const other = await makePurchase('late-conflict', 2, 30);
  const blocked = await db.CitaPaciente.create({ clinica_id: 1, paciente_id: 2, doctor_id: 1, instalacion_id: 1,
    inicio: '2030-01-08T09:00:00Z', fin: '2030-01-08T09:30:00Z', estado: 'pendiente' });
  const conflictCounts = await counts();
  await assert.rejects(service.book({ ...other.options, payload: { request_key: 'qa-late-conflict',
    snapshot_sha256: other.frozen.sha256, sessions: [{ key: 's0', start_at: '2030-01-08T09:00:00Z' }] } }),
  { code: 'program_booking_unavailable' });
  assert.deepEqual(await counts(), conflictCounts);
  assert.equal(Number((await other.voucher.reload()).available_units), 3);
  await blocked.destroy();
  report.checks.push('late occupied slot rolls back session/request/activity/occupancy atomically without any payment or consumption');

  const linked = await makePurchase('existing-source', 2, 30);
  const individual = await mutateAppointmentBooking({ db,
    appointmentValues: { clinica_id: 1, paciente_id: 1, doctor_id: 1, instalacion_id: 1, tratamiento_id: 2,
      inicio: '2030-01-08T11:00:00Z', fin: '2030-01-08T11:30:00Z', estado: 'info_confirmada',
      source_system: 'cliniccloud', source_reference: 'qa-source-individual', nota: 'Nota de cita ficticia',
      created_by: 1, updated_by: 1, import_metadata: { automation_policy: 'hold', source_receipt: { synthetic: true, preserved: true } } },
    persist: ({ values, transaction }) => db.CitaPaciente.create(values, { transaction }) });
  const signed = await db.PatientConsentDocument.create({ public_id: 'qa-signed-consent', paciente_id: 1,
    clinica_id: 1, cita_id: individual.id_cita, tratamiento_id: 2, title: 'Consentimiento ficticio firmado',
    status: 'signed', signed_by_patient_id: 1, signed_at: '2030-01-01T09:00:00Z',
    snapshot_hash: 'a'.repeat(64), snapshot_json: { synthetic: true, immutable_evidence: 'qa' } });
  // Compare persisted values, not create()'s unrounded timestamps/defaults.
  const signedBefore = (await signed.reload()).toJSON();
  const originalOccupancy = (await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: individual.id_cita },
    order: [['id', 'ASC']] })).map(row => row.toJSON());
  const payloadFor = async (requestKey = 'qa-link-existing') => ({ request_key: requestKey,
    snapshot_sha256: linked.frozen.sha256, expected_plan_revision: (await service.read(linked.options)).plan_revision,
    expected_appointment_revision: importReviewVersion((await individual.reload()).toJSON()),
    session_key: 's1', appointment_id: individual.id_cita });
  let payload = await payloadFor();
  await individual.update({ nota: 'Cambio concurrente ficticio' });
  const staleCounts = await counts();
  await assert.rejects(service.linkAppointment({ ...linked.options, payload }), { code: 'program_link_appointment_changed' });
  assert.deepEqual(await counts(), staleCounts);
  assert.equal((await individual.reload()).voucher_id, null);
  report.checks.push('real SQL appointment CAS rejects an unseen concurrent edit with no partial unit claim');
  payload = await payloadFor();
  const before = individual.toJSON();
  const linkedResult = await service.linkAppointment({ ...linked.options, payload });
  const after = (await individual.reload()).toJSON();
  for (const field of ['inicio', 'fin', 'estado', 'doctor_id', 'instalacion_id', 'tratamiento_id', 'source_system', 'source_reference',
    'tipo_cita', 'nota', 'arrived_at', 'care_started_at']) assert.deepEqual(after[field], before[field]);
  assert.deepEqual(after.import_metadata.booking, before.import_metadata.booking);
  assert.deepEqual(after.import_metadata.source_receipt, before.import_metadata.source_receipt);
  assert.equal(after.import_metadata.automation_policy, 'hold');
  assert.equal(Number(after.voucher_id), Number(linked.voucher.id));
  assert.deepEqual((await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: individual.id_cita },
    order: [['id', 'ASC']] })).map(row => row.toJSON()), originalOccupancy);
  assert.deepEqual((await signed.reload()).toJSON(), signedBefore);
  assert.deepEqual(linkedResult.prior_pending_keys, ['s0']);
  assert.deepEqual(linkedResult.following_pending_keys, ['s2']);
  assert.equal(linkedResult.consumed_units, 0);
  assert.equal(linkedResult.payment_created, false);
  assert.equal(Number((await linked.voucher.reload()).available_units), 3);
  assert.equal(Number(linked.voucher.sold_amount), 120);
  plan = await service.read(linked.options);
  assert.equal(plan.pending_count, 2);
  assert.equal(plan.sessions[1].scheduling_status, 'reserved');
  assert.equal(plan.sessions[0].start_at, null);
  assert.equal(plan.sessions[2].start_at, null);
  report.checks.push('SQL linking preserves original source/status/hours/note/occupancy/signed consent and units; entry session alone becomes reserved');
  const linkedCounts = await counts();
  const linkedReplay = await service.linkAppointment({ ...linked.options, payload });
  assert.equal(linkedReplay.replayed, true);
  assert.deepEqual(linkedReplay.sessions, linkedResult.sessions);
  assert.deepEqual(await counts(), linkedCounts);
  await assert.rejects(service.linkAppointment({ ...linked.options, payload: { ...payload, request_key: 'qa-link-stale-plan' } }),
    { code: 'program_resume_changed' });
  assert.deepEqual(await counts(), linkedCounts);
  report.checks.push('link replay is idempotent and a second request with stale SQL plan revision cannot claim another unit');

  const racing = await makePurchase('concurrent-links', 2, 30);
  const candidate = await mutateAppointmentBooking({ db,
    appointmentValues: { clinica_id: 1, paciente_id: 1, doctor_id: 1, instalacion_id: 1, tratamiento_id: 2,
      inicio: '2030-01-09T11:00:00Z', fin: '2030-01-09T11:30:00Z', estado: 'recordatorio_confirmado',
      source_system: 'cliniccloud', source_reference: 'qa-racing-source',
      import_metadata: { automation_policy: 'hold' } },
    persist: ({ values, transaction }) => db.CitaPaciente.create(values, { transaction }) });
  const racingRevision = (await service.read(racing.options)).plan_revision;
  const racingAppointmentRevision = importReviewVersion((await candidate.reload()).toJSON());
  const eventsBeforeRace = await db.PatientOperationalEvent.count();
  const race = await Promise.allSettled([0, 1].map(index => service.linkAppointment({
    ...racing.options, payload: { request_key: 'qa-racing-link-' + index, snapshot_sha256: racing.frozen.sha256,
      expected_plan_revision: racingRevision, expected_appointment_revision: racingAppointmentRevision,
      session_key: 's1', appointment_id: candidate.id_cita },
  })));
  assert.equal(race.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(race.find(row => row.status === 'rejected').reason.code, 'program_resume_changed');
  assert.equal(await db.PatientProgramSession.count({ where: { voucher_id: racing.voucher.id } }), 1);
  assert.equal(await db.PatientProgramBookingRequest.count({ where: { voucher_id: racing.voucher.id } }), 1);
  assert.equal(await db.CitaPaciente.count({ where: { voucher_id: racing.voucher.id } }), 1);
  assert.equal(await db.PatientOperationalEvent.count(), eventsBeforeRace + 1);
  assert.equal(Number((await racing.voucher.reload()).available_units), 3);
  report.checks.push('competing real SQL links of the same original and plan serialize on voucher lock: exactly one appointment/unit/request/activity survives');
  assert.equal(await db.PatientVoucherMovement.count(), 0);
  assert.equal(await db.EconomicPayment.count(), 0);
  assert.equal(await db.ConsentDeliveryEvent.count(), 0);
  report.checks.push('no consumption, payment, consent resend or provider/queue access is performed by manual scheduling or linking');
}).catch(error => { console.error(error); process.exitCode = 1; });
