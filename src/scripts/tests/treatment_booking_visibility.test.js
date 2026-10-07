'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const { mergeClinicalConfig, catalogDto } = require('../../lib/treatment-catalog-contract');
const { bookingVisibility } = require('../../lib/treatment-booking-visibility');
const { individualBookingEligible } = require('../../lib/appointment-booking-catalog');
const profileService = require('../../services/treatmentBookingProfile.service');
const { searchTreatmentSlots } = require('../../services/appointmentBookingAvailability.service');
const { snapshot, operationalSnapshot } = require('../../lib/economicProgramSnapshot');
const { createPatientProgramBookingService } = require('../../services/patientProgramBooking.service');
const { createAppointmentWithPatientLanguage, normalizePatientLanguage } = require('../../lib/patient-language');

// Reuse the actual offline canonical command fixture without registering its
// other tests. The mutation/solver/persistence handlers are production modules.
const corePath = require.resolve('./appointment_booking_core.test');
const coreRequire = createRequire(corePath), coreModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(corePath, 'utf8') + '\nmodule.exports = { fixture, profile, phase, capabilities };', {
  module: coreModule, structuredClone, Date, console,
  require: name => name === 'node:test' ? () => {} : coreRequire(name),
}, { filename: corePath });
const core = coreModule.exports;
const clone = value => JSON.parse(JSON.stringify(value));
const hidden = { booking_visibility: 'continuation_only' };

function fixture() {
  const f = core.fixture(), readTreatment = f.db.Tratamiento.findByPk;
  f.db.Tratamiento.findByPk = async (...args) => {
    const row = await readTreatment(...args);
    return { ...row, clinical_config: { ...row.clinical_config, ...hidden } };
  };
  f.care = (patch = {}) => f.state.appointments.push({ id_cita: 70 + f.state.appointments.length,
    ...f.values, inicio: '2000-01-01T09:00:00Z', fin: '2000-01-01T09:30:00Z', estado: 'completada', ...patch });
  f.guard = async (options = {}) => profileService.assertTreatmentBookingVisibility({ db: f.db,
    treatment: await f.db.Tratamiento.findByPk(3), appointmentValues: f.values, ...options });
  return f;
}

function voucherFixture(patch = {}) {
  const f = fixture();
  f.voucher = { id: 1, public_id: 'voucher-synthetic', clinic_id: 72, patient_id: 1, treatment_id: 3,
    status: 'active', source_system: 'clinicaclick', total_units: 3, available_units: 3, ...patch };
  f.movements = [];
  f.db.PatientVoucher = { findOne: async () => f.voucher };
  f.db.PatientVoucherMovement = { findAll: async () => f.movements };
  f.values.voucher_id = 1;
  return f;
}

function programFixture() {
  const f = voucherFixture({ source_system: 'treatment_program', budget_id: 4, budget_line_key: 'line', total_units: 1, available_units: 1 });
  const definition = { id: 'program-synthetic', version: 1, kind: 'program', status: 'active', name: 'Programa sintético',
    total_price: 50, summary: { issues: [] }, appointments: [{ key: 'session', label: 'Sesión comprada', offset_days: null,
      treatment_ids: [3], duration_minutes: 30, treatments: [{ id: 3, name: 'Técnica comprada', duration_minutes: 30,
        booking_profile: core.profile(core.phase('care')) }] }] };
  f.purchase = snapshot(definition);
  const session = operationalSnapshot(f.purchase).appointments[0];
  f.session = { id: 12, voucher_id: 1, session_key: session.key, position: 0, snapshot_sha256: f.purchase.sha256,
    snapshot: { ...session, program_cadence: f.purchase.cadence } };
  f.budget = { id: 4, clinic_id: 72, patient_id: 1, status: 'accepted', current_version: 1 };
  f.acceptance = { metadata: { accepted_line_keys: ['line'] } };
  f.db.PatientProgramSession = { findOne: async () => f.session, findAll: async () => [f.session] };
  f.db.EconomicBudget = { findOne: async () => f.budget };
  f.db.EconomicBudgetVersion = { findOne: async () => ({ lines: [{ key: 'line', program_snapshot: f.purchase }] }) };
  f.db.EconomicBudgetEvent = { findOne: async () => f.acceptance };
  f.book = candidate => f.db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, transaction => f.reserve({ transaction,
    trustedProgramSession: candidate || f.session }));
  return f;
}

test('visibility is one editable normalized key; clearing preserves every unrelated clinical and imported field', () => {
  const before = { unknown: { stable: true }, source_file: 'original', fiscal_mapping_pending: true,
    imported_price_review: { reviewed_by: 9 }, ...hidden };
  assert.deepEqual(mergeClinicalConfig(before, { financing: { enabled: true } }), { ...before, financing: { enabled: true } });
  const removed = mergeClinicalConfig(before, { booking_visibility: null });
  assert.equal(bookingVisibility({ clinical_config: removed }), null);
  assert.deepEqual(removed.unknown, before.unknown); assert.equal(removed.source_file, before.source_file);
  assert.equal(removed.fiscal_mapping_pending, true); assert.deepEqual(before, { unknown: { stable: true }, source_file: 'original',
    fiscal_mapping_pending: true, imported_price_review: { reviewed_by: 9 }, ...hidden });
  for (const value of ['', false, 'all', 'Continuation_only', {}, undefined]) {
    assert.throws(() => mergeClinicalConfig(null, { booking_visibility: value }), { code: 'booking_visibility_invalid' });
  }
});

test('ordinary offers exclude continuation-only; full catalogue DTO/detail/editor still retain active and config', () => {
  const row = { id_tratamiento: 3, activo: true, precio_base: 50, clinical_config: hidden };
  assert.equal(individualBookingEligible(row, 72), false);
  assert.equal(individualBookingEligible({ ...row, clinical_config: {} }, 72), true);
  assert.equal(individualBookingEligible({ ...row, clinical_config: JSON.stringify(hidden) }, 72), false);
  const dto = catalogDto(row);
  assert.equal(dto.activo, true); assert.equal(dto.standalone_sellable, true);
  assert.deepEqual(dto.clinical_config, hidden); assert.equal(dto.precio_base, 50);
  assert.doesNotThrow(() => profileService.requireOperationalProfile(row));
});

test('real canonical command rejects first booking even with continuation labels, metadata, force or allowObsolete', async () => {
  const f = fixture();
  await assert.rejects(f.reserve({ force: true, allowObsolete: true, appointmentValues: { ...f.values, tipo_cita: 'continuacion',
    care_started_at: '2000-01-01', source_system: 'treatment_program', import_metadata: { program_session: { session_id: '12' },
      booking_visibility: 'all', booking: { profile: core.profile(core.phase('fake')) } } } }), { code: 'booking_continuation_required' });
  assert.equal(f.state.persists, 0); assert.equal(f.state.occupancies.length, 0); assert.equal(f.state.rollbacks, 1);
});

test('real command accepts completed or actually started care of the same patient, clinic and exact treatment', async () => {
  for (const state of [{ estado: 'completada' }, { estado: 'pendiente', care_started_at: '2000-01-01T10:00:00Z' }]) {
    const f = fixture(); f.care(state);
    const row = await f.reserve(); assert.equal(row.tratamiento_id, 3); assert.equal(f.state.persists, 1);
  }
});

test('cancelled/no-show, other owner/clinic/treatment and unstarted/future care never prove continuation', async () => {
  for (const patch of [{ estado: 'cancelada', care_started_at: '2000-01-01' }, { estado: 'no_asistio', care_started_at: '2000-01-01' },
    { paciente_id: 2 }, { clinica_id: 73 }, { tratamiento_id: 4 }, { estado: 'pendiente' },
    { estado: 'pendiente', care_started_at: 'not-a-date' }, { estado: 'pendiente', care_started_at: '2099-01-01' },
    { estado: 'completada', fin: '2099-01-01' }]) {
    const f = fixture(); f.care(patch);
    await assert.rejects(f.reserve(), { code: 'booking_continuation_required' }); assert.equal(f.state.persists, 0);
  }
});

test('existing unstarted appointment remains editable, movable and cancellable without changing its booking snapshot', async () => {
  const f = core.fixture(); const existing = await f.reserve();
  const before = clone(existing.import_metadata.booking.profile);
  const read = f.db.Tratamiento.findByPk;
  f.db.Tratamiento.findByPk = async (...args) => { const row = await read(...args); return { ...row, clinical_config: { ...row.clinical_config, ...hidden } }; };
  const edited = await f.reserve({ existingAppointmentId: existing.id_cita, appointmentValues: { nota: 'Dato administrativo' } });
  assert.deepEqual(clone(edited.import_metadata.booking.profile), before);
  const moved = await f.reserve({ existingAppointmentId: existing.id_cita,
    appointmentValues: { inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:30:00Z' } });
  assert.deepEqual(clone(moved.import_metadata.booking.profile), before);
  const canceled = await f.reserve({ existingAppointmentId: existing.id_cita, appointmentValues: { estado: 'cancelada' }, stateOnly: true });
  assert.equal(canceled.estado, 'cancelada'); assert.deepEqual(clone(canceled.import_metadata.booking.profile), before);
});

test('existing ID cannot authorize another patient or reassign a new continuation-only treatment', async () => {
  const f = fixture(); f.care({ estado: 'pendiente' });
  await assert.rejects(f.reserve({ existingAppointmentId: 70, appointmentValues: { paciente_id: 2 } }), { code: 'booking_continuation_required' });
  f.state.appointments[0].tratamiento_id = 4;
  await assert.rejects(f.reserve({ existingAppointmentId: 70, appointmentValues: { tratamiento_id: 3 } }), { code: 'booking_continuation_required' });
});

test('real simple voucher command requires the actual active purchase with remaining unreserved units', async () => {
  const f = voucherFixture();
  f.care({ voucher_id: 1, estado: 'completada', id_cita: 71 }); f.movements.push({ appointment_id: 71 });
  const row = await f.reserve(); assert.equal(row.voucher_id, 1); assert.equal(f.voucher.available_units, 3);
  assert.equal(f.movements.length, 1, 'booking never consumes or invents purchased units');
});

test('started care does not bypass a submitted invalid, foreign, inactive, empty or expired voucher', async () => {
  for (const patch of [{ id: 2 }, { patient_id: 2 }, { clinic_id: 73 }, { treatment_id: 4 }, { status: 'pending' },
    { status: 'consumed' }, { available_units: 0 }, { available_units: 'NaN' }, { expires_at: '2000-01-01' },
    { expires_at: '2029-01-01' }]) {
    const f = voucherFixture(patch); f.care();
    await assert.rejects(f.reserve(), { code: 'booking_continuation_required' }); assert.equal(f.state.persists, 0);
  }
  const f = voucherFixture({ available_units: 1 }); f.care({ estado: 'reprogramada', voucher_id: 1 });
  await assert.rejects(f.reserve(), { code: 'booking_continuation_required' });
});

test('program command uses accepted purchase and actual frozen ledger, never a caller-authored profile', async () => {
  const f = programFixture(), candidate = clone(f.session);
  candidate.snapshot.booking_profile = core.profile(core.phase('forged', [10], [6]));
  const booked = await f.book(candidate);
  assert.equal(booked.doctor_id, 5); assert.equal(booked.instalacion_id, 9);
  assert.deepEqual(booked.import_metadata.booking.profile, f.session.snapshot.booking_profile);
  assert.equal(f.voucher.available_units, 1); assert.equal(f.session.appointment_id, undefined);
});

test('a program flag, absent ledger, changed owner/hash/composition or unaccepted purchase cannot authorize booking', async () => {
  for (const mutate of [f => { f.session = null; }, f => { f.session.voucher_id = 2; }, f => { f.session.id = 13; },
    f => { f.session.snapshot_sha256 = '0'.repeat(64); }, f => { f.session.snapshot.booking_profile.phases[0].installation_ids = [10]; },
    f => { f.session.snapshot.treatment_ids = [4]; }, f => { f.session.consumption_movement_id = 1; },
    f => { f.budget.patient_id = 2; }, f => { f.budget.status = 'presented'; },
    f => { f.budget.status = 'partially_accepted'; f.acceptance.metadata.accepted_line_keys = ['other']; }]) {
    const f = programFixture(), candidate = clone(f.session); mutate(f);
    await assert.rejects(f.book(candidate), { code: 'booking_continuation_required' }); assert.equal(f.state.persists, 0);
  }
  const f = programFixture();
  await assert.rejects(f.reserve({ appointmentValues: { ...f.values, source_system: 'treatment_program',
    import_metadata: { program_session: { session_id: 12 } } } }), { code: 'booking_continuation_required' });
});

test('partial acceptance proves only its real purchased line; a missed session may retain its purchased unit', async () => {
  const f = programFixture(); f.budget.status = 'partially_accepted';
  f.session.appointment_id = 70;
  f.care({ id_cita: 70, voucher_id: 1, estado: 'no_asistio' });
  const booked = await f.book(); assert.equal(booked.voucher_id, 1); assert.equal(f.voucher.available_units, 1);
});

test('slot search rejects hidden generic offers but uses verified initiated care for patient continuation', async () => {
  const f = fixture(), input = { db: f.db, clinic: f.clinic, treatmentId: 3,
    date: '2030-01-07', capabilities: core.capabilities, now: new Date('2030-01-01') };
  await assert.rejects(searchTreatmentSlots(input), { code: 'booking_continuation_required' });
  await assert.rejects(searchTreatmentSlots({ ...input, patientId: 1 }), { code: 'booking_continuation_required' });
  f.care();
  const slots = await searchTreatmentSlots({ ...input, patientId: 1 }); assert(slots.slots.length > 0);
});

function createHandlerFixture({ started = false, revokeInTransaction = false } = {}) {
  const f = fixture(), writes = [], effects = [];
  const loadTreatment = f.db.Tratamiento.findByPk;
  f.db.Tratamiento.findByPk = async (...args) => ({ ...await loadTreatment(...args), duracion_min: 30, clinical_config: { ...hidden } });
  if (started) f.care();
  const patient = { id_paciente: 1 };
  f.db.sequelize.transaction = async callback => {
    if (revokeInTransaction) f.state.appointments = [];
    return callback({ LOCK: { UPDATE: 'UPDATE' }, pending: [], replacements: new Set() });
  };
  f.db.CitaPaciente.create = async values => { writes.push(clone(values)); return { id_cita: 200, ...values }; };
  const findByPk = f.db.CitaPaciente.findByPk;
  f.db.CitaPaciente.findByPk = async (id, options) => Number(id) === 200 ? writes[0] : findByPk(id, options);
  const controllerPath = require.resolve('../../controllers/citas.controller'), actualRequire = createRequire(controllerPath);
  const source = fs.readFileSync(controllerPath, 'utf8');
  const start = source.indexOf('exports.createCita ='), end = source.indexOf('\n/**\n * Listar citas', start);
  const exported = {}, nothing = async () => {};
  vm.runInNewContext(source.slice(start, end), { exports: exported, Date, console,
    require: name => name === './appointmentConsentEligibility.service' || name === '../services/appointmentConsentEligibility.service'
      ? { assertClinicalCompletion: nothing } : actualRequire(name), db: f.db,
    ...profileService, bookingCapabilities: () => ({ simple: false, multi: false }),
    asyncHandler: fn => fn, normalizePatientLanguage, CITA_ESTADOS_VALIDOS: new Set(['pendiente', 'completada']),
    Clinica: { findOne: async () => f.clinic }, Tratamiento: f.db.Tratamiento, CitaPaciente: f.db.CitaPaciente,
    assertAppointmentManageAccess: nothing, resolveClinicTimezone: () => 'Europe/Madrid', parsePositiveInt: value => Number(value) || null,
    findPacienteByIdentifier: async () => patient, actorCanReadPatientSensitive: async () => true,
    parseBool: value => value === true, cleanOptionalString: value => value || null,
    normalizeAdditionalStaff: () => [], normalizeAppointmentNotificationSuppression: () => null, parsePlainObject: value => value || {},
    checkDisponibilidadCanonica: async () => ({ resourceConflicts: [], legacyConflicts: [], canForce: false }),
    findOrCreatePaciente: async () => { effects.push('patient'); return patient; },
    createAppointmentWithPatientLanguage, applyExplicitPatientLanguage: nothing,
    recordCreatedAppointmentLead: async () => null, enqueueCreatedAppointmentCrmSignals: nothing,
    appointmentAutomationV2Runtime: { enqueueExecutionForCita: nothing, syncScheduledTriggersForCita: nothing },
    ensureConsentPackageAndAutomation: nothing, processAppointmentLeadMilestones: nothing,
    patientDirectionService: { handleAppointmentChange: nothing }, Paciente: {}, LeadIntake: {}, Campana: null, Instalacion: {},
    attachFlowSummaryToCitas: nothing, attachUnreadCountsToCitas: nothing, attachAppointmentProgramContexts: nothing,
    consentimientosService: { attachConsentSummaryToCitas: nothing }, attachResolvedAppointmentPricesToCitas: () => {},
    emitAppointmentSocketEvent: () => {}, protectAppointmentsForRequest: async (req, row) => row,
    sendAppointmentAccessPolicyError: () => false,
  }, { filename: controllerPath });
  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  const request = { userData: { userId: 9 }, body: { ...f.values, paciente: { id_paciente: 1 },
    duracion_min: 30, tipo_cita: 'continuacion', historical_registration: true, import_metadata: { program_session: { session_id: 12 } } } };
  return { f, writes, effects, response, request, create: () => exported.createCita(request, response) };
}

test('real HTTP create handler enforces visibility while booking flags are off and historical label is future', async () => {
  const f = createHandlerFixture(); await f.create();
  assert.equal(f.response.statusCode, 409); assert.equal(f.response.body.code, 'booking_continuation_required');
  assert.equal(f.writes.length, 0); assert.equal(f.effects.length, 0);
});

test('legacy HTTP transaction rechecks proof before create, not after a self-authored completed row', async () => {
  const f = createHandlerFixture({ started: true, revokeInTransaction: true });
  f.request.body.estado = 'completada'; await f.create();
  assert.equal(f.response.statusCode, 409); assert.equal(f.response.body.code, 'booking_continuation_required');
  assert.equal(f.writes.length, 0);
});

test('real legacy HTTP continuation handler still creates once when genuine initiated care exists', async () => {
  const f = createHandlerFixture({ started: true }); await f.create();
  assert.equal(f.response.statusCode, 201); assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].import_metadata?.program_session, undefined);
});

test('actual purchased programme service books a hidden treatment without altering catalogue or snapshot', async () => {
  const f = programFixture(), records = [], requests = [];
  f.db.PatientProgramSession = { findOne: async ({ where }) => records.find(row => Number(row.id) === Number(where.id) && Number(row.voucher_id) === Number(where.voucher_id)),
    findAll: async () => records,
    create: async values => {
      const row = { id: 12, ...values, async update(patch) { Object.assign(this, patch); return this; } };
      records.push(row); return row;
    } };
  f.db.PatientProgramBookingRequest = { findOne: async () => null, create: async values => { requests.push(values); } };
  f.db.CitaPaciente.create = async (values, { transaction }) => f.persist({ values, transaction });
  const service = createPatientProgramBookingService({ db: f.db, enabled: () => true,
    capabilities: () => core.capabilities, now: () => new Date('2030-01-01T00:00:00Z') });
  const result = await service.book({ publicId: f.voucher.public_id, clinicId: 72, actorId: 9, payload: {
    request_key: 'visibility-real-service', snapshot_sha256: f.purchase.sha256,
    sessions: [{ key: 'session', start_at: '2030-01-07T09:00:00Z', selections: {} }],
  } });
  assert.equal(result.sessions.length, 1); assert.equal(records.length, 1); assert.equal(requests.length, 1);
  assert.equal(f.voucher.available_units, 1); assert.equal(f.state.persists, 1);
  assert.equal((await f.db.Tratamiento.findByPk(3)).clinical_config.booking_visibility, 'continuation_only');
  assert.deepEqual(f.state.appointments[0].import_metadata.booking.profile, records[0].snapshot.booking_profile);
});

function voucherPlannerFixture(patch = {}) {
  const f = voucherFixture({ available_units: 2, ...patch }), events = [];
  f.db.Tratamiento.findByPk = async () => ({ id_tratamiento: 3, origen: 'clinica', clinica_id: 72, activo: true,
    nombre: 'Tratamiento sintético', duracion_min: 30, clinical_config: hidden });
  const hours = Array.from({ length: 7 }, (_, dia_semana) => ({ dia_semana, activo: true, hora_inicio: '08:00', hora_fin: '20:00' }));
  f.db.DoctorClinica.findOne = async () => ({ doctor_id: 5, clinica_id: 72, recibe_citas: true, horarios: hours });
  f.db.Instalacion.findOne = async () => ({ id: 9, clinica_id: 72, horarios: hours, bloqueos: [] });
  const transaction = f.db.sequelize.transaction;
  f.db.sequelize.transaction = (options, callback) => transaction(typeof options === 'function' ? {} : options,
    typeof options === 'function' ? options : callback);
  f.db.CitaPaciente.create = (values, { transaction }) => f.persist({ values, transaction });
  const filename = require.resolve('../../services/patientVoucherAppointments.service'), localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, console, Date,
    require: name => name === '../../models' ? f.db
      : name === './appointmentAutomationV2Runtime.service' ? { enqueueExecutionForCita: async () => events.push('created'), syncScheduledTriggersForCita: async () => events.push('sync') }
        : name === './treatmentBookingProfile.service' ? { ...profileService, bookingCapabilities: () => ({ simple: false, multi: false }) }
          : localRequire(name),
  }, { filename });
  f.service = module.exports; f.events = events;
  f.payload = { start_at: '2030-01-07T10:00:00+01:00', count: 2, interval_days: 7, doctor_id: 5, installation_id: 9 };
  return f;
}

test('real legacy simple-voucher planner continues hidden purchase with same units, scope and capacity checks', async () => {
  const f = voucherPlannerFixture();
  const preview = await f.service.preview({ publicId: f.voucher.public_id, payload: f.payload });
  assert.equal(preview.has_conflicts, false); assert.equal(f.state.persists, 0);
  const result = await f.service.create({ publicId: f.voucher.public_id, payload: f.payload, actorId: 9 });
  assert.equal(result.created.length, 2); assert.equal(f.state.persists, 2); assert.equal(f.voucher.available_units, 2);
  assert(f.state.appointments.every(row => row.voucher_id === 1 && row.paciente_id === 1 && row.clinica_id === 72));
  await assert.rejects(f.service.preview({ publicId: f.voucher.public_id, payload: f.payload }), { code: 'booking_continuation_required' });
});

test('legacy voucher planner cannot treat pending activation or an over-capacity series as purchased continuation', async () => {
  const pending = voucherPlannerFixture({ status: 'pending' });
  await assert.rejects(pending.service.create({ publicId: pending.voucher.public_id, payload: pending.payload, actorId: 9 }), { code: 'booking_continuation_required' });
  const full = voucherPlannerFixture({ available_units: 1 });
  await assert.rejects(full.service.create({ publicId: full.voucher.public_id, payload: full.payload, actorId: 9 }), { code: 'voucher_schedule_count_invalid' });
  assert.equal(pending.state.persists + full.state.persists, 0);
});

function previewHandlerFixture({ started = false, denied = null } = {}) {
  const f = fixture(), acl = [], contexts = [];
  if (started) f.care();
  const filename = require.resolve('../../controllers/disponibilidad.controller'), localRequire = createRequire(filename);
  const exported = {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports: exported, console, Date, Map, Set, Promise,
    require: name => name === '../../models' ? f.db : name === 'express-async-handler' ? fn => fn
      : name === '../lib/access-policy' ? { assertUserCanAccessFeature: async input => {
        acl.push(input); if (input.featureKey === denied) throw Object.assign(Error('denied'), { statusCode: 403 });
      } }
        : name === '../services/patientEconomics.service' ? { loadContext: async (identifier, clinicId) => {
          contexts.push([identifier, clinicId]);
          if (identifier !== 'pat-synthetic' || clinicId !== 72) throw Object.assign(Error('wrong patient'), { statusCode: 404 });
          return { patient: { id_paciente: 1 }, clinic: f.clinic };
        } }
          : name === '../services/treatmentBookingProfile.service' ? { ...profileService,
            bookingCapabilities: () => core.capabilities,
            requireOperationalProfile: (treatment, options) => profileService.requireOperationalProfile(treatment, { capabilities: core.capabilities, ...options }) }
            : name === '../services/appointmentBookingAvailability.service' ? { ...localRequire(name),
              searchTreatmentSlots: input => searchTreatmentSlots({ ...input, capabilities: core.capabilities, now: new Date('2030-01-01') }) }
              : localRequire(name),
  }, { filename });
  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  const request = { userData: { userId: 9 }, query: { clinica_id: '72', tratamiento_id: '3', doctor_id: '5', instalacion_id: '9',
    inicio_local: '2030-01-07T10:00', fin_local: '2030-01-07T10:30', fecha_local: '2030-01-07', duracion_min: '30' } };
  return { f, acl, contexts, request, response, check: () => exported.check(request, response), search: () => exported.treatmentSlots(request, response) };
}

test('real HTTP preview requires patient ACLs and clinic membership before initiated-care proof', async () => {
  const f = previewHandlerFixture({ started: true }); f.request.query.patient_id = 'pat-synthetic';
  await f.check(); assert.equal(f.response.body.available, true); assert.equal(f.f.state.persists, 0);
  assert.deepEqual(f.contexts, [['pat-synthetic', 72]]);
  assert.deepEqual(f.acl.map(row => row.featureKey), ['appointments.view', 'patients.view', 'patients.sensitive.view']);
  const denied = previewHandlerFixture({ started: true, denied: 'patients.sensitive.view' });
  denied.request.query.patient_id = 'pat-synthetic'; await assert.rejects(denied.check(), { statusCode: 403 });
  assert.equal(denied.contexts.length, 0);
});

test('HTTP generic preview stays hidden while a real existing appointment can still be checked', async () => {
  const f = previewHandlerFixture();
  await assert.rejects(f.check(), { code: 'booking_continuation_required' });
  f.f.care({ id_cita: 70, estado: 'pendiente', inicio: f.f.values.inicio, fin: f.f.values.fin });
  f.request.query.ignore_cita_id = 70;
  await f.check(); assert.equal(f.response.body.available, true);
  f.request.query.ignore_cita_id = 999;
  await assert.rejects(f.check(), { code: 'appointment_not_found' });
});

test('real HTTP treatment-slot planner uses patient context and returns no clinical proof/patient data', async () => {
  const f = previewHandlerFixture({ started: true }); f.request.query.paciente_id = 'pat-synthetic';
  await f.search(); assert(f.response.body.slots.length > 0);
  assert.doesNotMatch(JSON.stringify(f.response.body), /paciente_id|patient_id|care_started_at|source_appointment_id/);
});

test('ordinary HTTP create cannot claim ClinicCloud identity or manufacture source metadata; unrelated metadata survives', async () => {
  const denied = createHandlerFixture({ started: true }); denied.request.body.source_system = 'cliniccloud';
  await denied.create(); assert.equal(denied.response.statusCode, 409);
  assert.equal(denied.response.body.code, 'booking_import_provenance_server_owned'); assert.equal(denied.writes.length, 0);
  const f = createHandlerFixture({ started: true });
  f.request.body.import_metadata = { source_account: 'cliniccloud-5880', source_service_id: '900', raw: { idServicio: '900' },
    cliniccloud_delta: { pending_assignment: ['treatment_id'] }, cliniccloud_reconciliation: { claimed: true }, unrelated: { preserved: true } };
  await f.create(); assert.equal(f.response.statusCode, 201);
  assert.deepEqual(clone(f.writes[0].import_metadata.unrelated), { preserved: true });
  assert(!Object.keys(f.writes[0].import_metadata).some(key => key === 'raw' || key.startsWith('source_') || key.startsWith('cliniccloud_')));
});

test('generic command preserves real source fields and unrelated edits, rejecting new/replaced source identity', async () => {
  const f = core.fixture(), importedMetadata = { source_account: 'cliniccloud-5880', source_service_id: '900', raw: { idServicio: '900' },
    cliniccloud_delta: { trusted: true }, other: 'old' };
  const record = await f.reserve();
  record.source_system = 'cliniccloud'; record.source_reference = 'appointment:100';
  Object.assign(record.import_metadata, importedMetadata);
  const edited = await f.reserve({ existingAppointmentId: record.id_cita, appointmentValues: { nota: 'Cambio administrativo',
    import_metadata: { source_service_id: '901', source_account: null, raw: null, cliniccloud_delta: null, other: 'new' } } });
  for (const key of ['source_account', 'source_service_id', 'raw', 'cliniccloud_delta']) {
    assert.deepEqual(clone(edited.import_metadata[key]), importedMetadata[key]);
  }
  assert.equal(edited.import_metadata.other, 'new');
  await assert.rejects(f.reserve({ existingAppointmentId: record.id_cita, appointmentValues: { source_reference: 'appointment:101' } }), { code: 'booking_import_provenance_server_owned' });
  await assert.rejects(f.reserve({ existingAppointmentId: record.id_cita, appointmentValues: { source_system: null } }), { code: 'booking_import_provenance_server_owned' });
  await assert.rejects(core.fixture().reserve({ appointmentValues: { ...f.values, source_system: 'cliniccloud' } }), { code: 'booking_import_provenance_server_owned' });
});

function importedClassificationFixture() {
  const filename = require.resolve('./appointment_import_classification_booking.test'), localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports = { fixture };', {
    module, structuredClone, Date, console, require: name => name === 'node:test' ? () => {} : localRequire(name),
  }, { filename });
  const f = module.exports.fixture({ treatmentPatch: { codigo: 'CCLOUD-900', clinical_config: { ...hidden,
    source_system: 'cliniccloud', source_batch: 'cliniccloud_bsmedical_real_20260726', source_reference: 'service:900', raw: { idServicio: '900' } } } });
  f.state.row.created_by = null; f.state.row.source_reference = 'appointment:100';
  Object.assign(f.state.row.import_metadata, { source_account: 'cliniccloud-5880', source_appointment_id: '100', source_contact_id: '200',
    source_service_id: '900', raw: { idCita: '100', idContacto: '200', idServicio: '900' } });
  f.db.CitaPaciente.findAll = async () => [];
  return f;
}

test('verified legacy import may be classified documentarily while hidden, without rebooking or touching purchases', async () => {
  const f = importedClassificationFixture(), before = clone(f.state);
  let purchaseReads = 0;
  f.db.PatientVoucher = { findOne: async () => { purchaseReads++; throw Error('Documentary classification must not touch purchases'); } };
  await f.run();
  assert.equal(f.state.row.tratamiento_id, 3); assert.equal(f.state.occupancyWrites, 0); assert.equal(purchaseReads, 0);
  assert.deepEqual(clone(f.state.occupancy), before.occupancy);
  assert.deepEqual(clone(f.state.row.import_metadata.booking), before.row.import_metadata.booking);
  for (const key of ['inicio', 'fin', 'doctor_id', 'instalacion_id', 'paciente_id', 'clinica_id', 'voucher_id']) {
    assert.equal(f.state.row[key], before.row[key]);
  }
  assert.equal(f.state.events.length, 1);
});

test('classification cannot release hidden treatment from a name, user-authored provenance, stale act or wrong source ID', async () => {
  for (const mutate of [f => { f.state.row.created_by = 9; }, f => { delete f.state.row.created_by; }, f => { f.state.row.import_metadata.source_service_id = '901'; },
    f => { delete f.state.row.import_metadata.raw; }, f => { f.state.row.import_metadata.raw.idServicio = '901'; },
    f => { f.state.row.import_metadata.source_account = 'another-source'; }, f => { f.treatment.codigo = 'CCLOUD-901'; },
    f => { f.state.row.import_metadata.cliniccloud_source_refreshes = { changed: true }; },
    f => { delete f.state.row.import_metadata.source_service_id; f.state.row.import_metadata.cliniccloud_delta.source.service_key = f.treatment.nombre; }]) {
    const f = importedClassificationFixture(); mutate(f); const before = clone(f.state);
    await assert.rejects(f.run(), { code: 'booking_continuation_required' });
    assert.deepEqual(clone(f.state.row), before.row); assert.deepEqual(clone(f.state.occupancy), before.occupancy);
    assert.equal(f.state.occupancyWrites, 0); assert.equal(f.state.persisted, 0); assert.equal(f.state.events.length, 0);
  }
});

function catalogueHandlerFixture({ denied = null } = {}) {
  const f = fixture(), acl = [];
  const row = { id_tratamiento: 3, clinica_id: 72, origen: 'clinica', activo: true, clinical_config: hidden };
  f.db.Tratamiento.findAll = async () => [row];
  const filename = require.resolve('../../controllers/tratamientos.controller');
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('exports.getTratamientos ='), end = source.indexOf('// Crear tratamiento', start);
  const localRequire = createRequire(filename), exported = {};
  vm.runInNewContext(source.slice(start, end), { exports: exported, Date, Set, db: f.db, Op: f.db.Sequelize.Op,
    asyncHandler: fn => fn, Tratamiento: f.db.Tratamiento, Clinica: f.db.Clinica,
    toIntOrNull: value => Number(value) || null, resolveGroupIdForClinicId: async () => 2,
    resolveClinicDisciplines: async () => ['general'], expandTreatmentDisciplineCodes: value => value,
    catalogDto,
    require: name => name === '../lib/access-policy' ? { assertUserCanAccessFeature: async input => {
      acl.push(input); if (input.featureKey === denied) throw Object.assign(Error('denied'), { statusCode: 403 });
    } } : name === '../services/patientEconomics.service' ? { loadContext: async (identifier, clinicId) => {
      assert.equal(identifier, 'pat-synthetic'); assert.equal(clinicId, 72); return { patient: { id_paciente: 1 } };
    } } : localRequire(name),
  }, { filename });
  const response = { status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  const request = { userData: { userId: 9 }, query: { clinica_id: 72, booking: 'true' } };
  return { f, acl, row, response, request, read: () => exported.getTratamientos(request, response) };
}

test('real catalogue booking projection bulk-adds only server-proved initiated treatments for a scoped patient', async () => {
  const f = catalogueHandlerFixture(); await f.read(); assert.equal(f.response.body.length, 0);
  f.request.query.patient_id = 'pat-synthetic'; await f.read(); assert.equal(f.response.body.length, 0);
  f.f.care(); await f.read(); assert.equal(f.response.body.length, 1);
  assert.deepEqual(f.acl.slice(-3).map(row => row.featureKey), ['appointments.view', 'patients.view', 'patients.sensitive.view']);
  const reads = f.f.state.calls.filter(([key, options]) => key === 'appointments' && options.group);
  assert.equal(reads.length, 2, 'one grouped lookup per patient request, not one query per treatment');
  assert(reads.every(([, options]) => options.where.clinica_id === 72 && options.where.paciente_id === 1));
});

test('catalogue patient hints/flags never grant eligibility; inactive/standalone/product rules still apply', async () => {
  const f = catalogueHandlerFixture(); f.request.query.tipo_cita = 'continuacion'; f.request.query.allowObsolete = 'true';
  await f.read(); assert.equal(f.response.body.length, 0);
  f.request.query.paciente_id = 'pat-synthetic'; f.f.care({ estado: 'no_asistio', care_started_at: '2000-01-01' });
  await f.read(); assert.equal(f.response.body.length, 0);
  f.f.care({ estado: 'pendiente', care_started_at: '2099-01-01' }); await f.read(); assert.equal(f.response.body.length, 0);
  f.f.care(); f.row.activo = false; await f.read(); assert.equal(f.response.body.length, 0);
  f.row.activo = true; f.row.clinical_config.product_type = 'voucher'; await f.read(); assert.equal(f.response.body.length, 0);
  const denied = catalogueHandlerFixture({ denied: 'patients.sensitive.view' }); denied.request.query.patient_id = 'pat-synthetic';
  await assert.rejects(denied.read(), { statusCode: 403 });
});
