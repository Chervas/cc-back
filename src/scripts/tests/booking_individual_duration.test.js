'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { resolveBookingProfileDuration, durationSelectionForRequest, durationRequirements } = require('../../lib/booking-profile-duration');
const { requireOperationalProfile } = require('../../services/treatmentBookingProfile.service');
const profileService = require('../../services/treatmentBookingProfile.service');
const { individualBookingEligible } = require('../../lib/appointment-booking-catalog');
const { searchTreatmentSlots } = require('../../services/appointmentBookingAvailability.service');
const { bookingSegments } = require('../../lib/appointment-booking-segments');

const capabilities = { simple: true, multi: true, relativeSteps: true };
const phase = (key = 'care', patch = {}) => ({ key, label: 'Atención ficticia', duration_minutes: null,
  installation_ids: [9], professionals: { mode: 'any', ids: [5], preferred_id: 5 }, ...patch });
const template = (version = 1, phases = [phase()]) => ({ version, phases: phases.map(item => ({ ...item,
  ...(version === 4 ? { start_offset_minutes: item.start_offset_minutes ?? 0 } : {}) })) });
const treatment = value => ({ id_tratamiento: 3, activo: true, nombre: 'Individual ficticio', clinical_config: { booking_profile: value } });
const resolve = (value, selection) => resolveBookingProfileDuration(value, { durationSelection: selection });

// Reuse the existing isolated DB/transaction harness, not a mock of the command
// or solver. Load only declarations before any tests; no DB, env or providers.
const fixturePath = require.resolve('./appointment_booking_core.test');
const fixtureSource = fs.readFileSync(fixturePath, 'utf8');
const harness = { exports: {} };
vm.runInNewContext(fixtureSource.slice(0, fixtureSource.indexOf('\ntest(')) + '\nmodule.exports.fixture = fixture;', {
  module: harness, exports: harness.exports, require: createRequire(fixturePath), Date, Map, Set, Promise, Buffer, console,
}, { filename: fixturePath });
const fixture = harness.exports.fixture;

test('only physically complete variable templates are selectable, not yet reservable', () => {
  const value = template();
  assert.equal(individualBookingEligible(treatment(value), 72, { capabilities }), true);
  assert.throws(() => requireOperationalProfile(treatment(value), { capabilities }), { code: 'booking_duration_required' });
  assert.deepEqual(durationRequirements(value), { required: true, input: 'duration_minutes', phases: [{ key: 'care', label: 'Atención ficticia' }] });
  for (const broken of [template(1, [phase('care', { installation_ids: [] })]),
    template(1, [phase('care', { professionals: { mode: 'any', ids: [], preferred_id: null } })])]) {
    assert.equal(individualBookingEligible(treatment(broken), 72, { capabilities }), false);
    assert.throws(() => resolve(broken, { duration_minutes: 30 }), { code: 'booking_profile_invalid' });
  }
});

test('single null duration requires an integer choice and freezes it for versions 1–4', () => {
  for (const version of [1, 2, 3, 4]) {
    const value = template(version), original = JSON.stringify(value);
    const result = resolve(value, { duration_minutes: 45 });
    assert.equal(result.profile.version, version);
    assert.equal(result.profile.phases[0].duration_minutes, 45);
    assert.deepEqual(result.duration_selection, { duration_minutes: 45, phase_durations: { care: 45 } });
    assert.equal(JSON.stringify(value), original);
    assert.throws(() => resolve(value, { phase_durations: { care: 45 } }), { code: 'booking_duration_required' });
  }
});

test('multiple phases require every pending phase explicitly, not inferred from total', () => {
  const value = template(1, [phase('first'), phase('fixed', { duration_minutes: 10 }), phase('last')]);
  for (const choice of [undefined, { duration_minutes: 50 }, { phase_durations: { first: 20 } }]) {
    assert.throws(() => resolve(value, choice), { code: 'booking_duration_required' });
  }
  const result = resolve(value, { phase_durations: { first: 20, last: 15 }, duration_minutes: 45 });
  assert.deepEqual(result.profile.phases.map(item => item.duration_minutes), [20, 10, 15]);
  assert.deepEqual(result.duration_selection, { duration_minutes: 45, phase_durations: { first: 20, last: 15 } });
  assert.throws(() => resolve(value, { phase_durations: { first: 20, fixed: 10, last: 15 } }), { code: 'booking_duration_locked' });
  assert.throws(() => resolve(value, { phase_durations: { first: 20, last: 15 }, duration_minutes: 46 }), { code: 'booking_duration_locked' });
});

test('v4 overlapping steps use explicit offsets and span, never summed duration', () => {
  const value = template(4, [phase('first'), phase('second', { start_offset_minutes: 15 })]);
  const result = resolve(value, { phase_durations: { first: 40, second: 20 }, duration_minutes: 40 });
  assert.deepEqual(result.profile.phases.map(item => item.start_offset_minutes), [0, 15]);
  assert.equal(result.duration_selection.duration_minutes, 40);
  assert.throws(() => resolve(value, { phase_durations: { first: 40, second: 20 }, duration_minutes: 60 }), { code: 'booking_duration_locked' });
  assert.throws(() => resolve(template(4, [phase('first'), phase('second', { start_offset_minutes: 1430 })]),
    { phase_durations: { first: 15, second: 15 } }), { code: 'booking_profile_invalid' });
});

test('fixed profiles accept exact total without rewriting their phase durations', () => {
  const value = template(1, [phase('one', { duration_minutes: 30 }), phase('two', { duration_minutes: 15 })]);
  assert.deepEqual(resolve(value, { duration_minutes: 45 }).profile, normalizeBookingProfile(value));
  assert.equal(resolve(value, { duration_minutes: 45 }).duration_selection, null);
  assert.throws(() => resolve(value, { duration_minutes: 50 }), { code: 'booking_duration_locked' });
  assert.throws(() => resolve(value, { phase_durations: { one: 30 } }), { code: 'booking_duration_locked' });
});

test('new duration contract never supplies missing resources or a default 30', () => {
  assert.equal(requireOperationalProfile(treatment(null), { capabilities }), null);
  assert.throws(() => requireOperationalProfile(treatment(null), { capabilities, durationSelection: { duration_minutes: 30 } }), { code: 'booking_profile_missing' });
  const incomplete = template(1, [phase('one', { installation_ids: [] })]);
  assert.throws(() => requireOperationalProfile(treatment(incomplete), { capabilities, durationSelection: { duration_minutes: 30 } }), { code: 'booking_profile_invalid' });
});

test('duration selection shape and bounds reject coercion, partial and extraneous input', () => {
  for (const choice of [null, [], { duration_minutes: null }, { duration_minutes: '30' }, { duration_minutes: 1.5 },
    { duration_minutes: 0 }, { duration_minutes: 1441 }, { duration_minutes: 30, installation_id: 9 },
    { duration_minutes: 30, phase_durations: null }, { duration_minutes: 30, phase_durations: [] },
    { duration_minutes: 30, phase_durations: { care: '30' } }]) assert.throws(() => resolve(template(), choice), { code: 'booking_duration_invalid' });
  assert.equal(resolve(template(), { duration_minutes: 1440 }).profile.phases[0].duration_minutes, 1440);
  assert.throws(() => resolve(template(1, [phase('a'), phase('b')]), { phase_durations: { a: 1000, b: 500 } }), { code: 'booking_profile_invalid' });
});

test('chosen duration must contain quantified attention windows without deleting requirements', () => {
  for (const policy of [{ mode: 'start_only', start_minutes: 5, start_window_minutes: 15 },
    { mode: 'start_continuous', start_minutes: 5, start_window_minutes: 15 },
    { mode: 'start_end', start_minutes: 5, start_window_minutes: 10, end_minutes: 5, end_window_minutes: 10 },
    { mode: 'continuous', patient_preparation_minutes: 10 }]) {
    const value = template(4, [phase('care', { staff_attention: [policy] })]);
    assert.throws(() => resolve(value, { duration_minutes: 5 }), { code: 'booking_duration_attention_invalid' });
    assert.deepEqual(resolve(value, { duration_minutes: 30 }).profile.phases[0].staff_attention, [policy]);
  }
});

test('variable duration respects operational capabilities, lifecycle and pending clinical attention', () => {
  assert.throws(() => requireOperationalProfile(treatment(template()), { capabilities: { simple: false, multi: false },
    durationSelection: { duration_minutes: 30 } }), { code: 'booking_profile_runtime_unavailable' });
  assert.throws(() => requireOperationalProfile(treatment(template(4)), { capabilities: { simple: true, multi: true },
    durationSelection: { duration_minutes: 30 } }), { code: 'booking_profile_runtime_unavailable' });
  const pending = template(4, [phase('care', { attention_requirements_pending: [{ key: 'check', label: 'Comprobación sin minutos' }] })]);
  assert.throws(() => requireOperationalProfile(treatment(pending), { capabilities, durationSelection: { duration_minutes: 30 } }), { code: 'pending_attention_requirements' });
  assert.throws(() => requireOperationalProfile({ ...treatment(template()), activo: false }, { capabilities,
    durationSelection: { duration_minutes: 30 } }), { code: 'treatment_not_bookable' });
});

test('HTTP boundary only parses canonical query numbers and pending legacy duration', () => {
  const value = treatment(template());
  assert.deepEqual(durationSelectionForRequest(value, { duration_minutes: '45' }, { query: true }), { duration_minutes: 45 });
  assert.deepEqual(durationSelectionForRequest(value, { phase_durations: '{"care":45}' }, { query: true }), { phase_durations: { care: 45 } });
  assert.deepEqual(durationSelectionForRequest(value, { duracion_min: '45' }), { duration_minutes: 45 });
  assert.equal(durationSelectionForRequest(treatment(null), { duracion_min: '45' }), undefined);
  assert.equal(durationSelectionForRequest(treatment(template(1, [phase('care', { duration_minutes: 30 })])), { duracion_min: '45' }), undefined);
  for (const raw of ['45.5', '45x', ' 45', '045', null]) assert.throws(() => durationSelectionForRequest(value, { duration_minutes: raw }, { query: true }), { code: 'booking_duration_invalid' });
  assert.throws(() => durationSelectionForRequest(value, { phase_durations: 'bad json' }, { query: true }), { code: 'booking_duration_invalid' });
});

test('actual availability and canonical transaction use the same selected individual duration', async () => {
  const f = fixture({ bookingProfile: template() });
  const result = await searchTreatmentSlots({ db: f.db, clinic: f.clinic, treatmentId: 3, date: '2030-01-07',
    capabilities, now: new Date('2030-01-01'), durationSelection: { duration_minutes: 45 }, limit: 3 });
  assert.equal(result.duration_minutes, 45); assert.ok(result.slots.length);
  const slot = result.slots[0];
  const saved = await f.reserve({ capabilities, durationSelection: { duration_minutes: 45 },
    appointmentValues: { ...f.values, inicio: slot.start_at, fin: null } });
  assert.equal(new Date(saved.fin).toISOString(), slot.end_at);
  assert.deepEqual(saved.import_metadata.booking.duration_selection, { duration_minutes: 45, phase_durations: { care: 45 } });
  assert.equal(saved.import_metadata.booking.profile.phases[0].duration_minutes, 45);
  assert.equal(template().phases[0].duration_minutes, null);
  assert.equal(f.state.occupancies.filter(row => row.resource_kind === 'doctor').length, 1);
});

test('snapshot duration survives catalog changes, moving, cancellation and missing old occupancy rows', async () => {
  const f = fixture({ bookingProfile: template() });
  const saved = await f.reserve({ durationSelection: { duration_minutes: 45 },
    appointmentValues: { ...f.values, fin: '2030-01-07T09:45:00Z' } });
  const receipt = saved.import_metadata.booking.duration_selection;
  f.db.Tratamiento.findByPk = async () => ({ ...treatment(template(1, [phase('other', { duration_minutes: 20, installation_ids: [10] })])), origen: 'clinica', clinica_id: 72 });
  f.state.occupancies = []; // A repair cannot reinterpret the catalog template.
  const moved = await f.reserve({ existingAppointmentId: saved.id_cita, appointmentValues: { inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:45:00Z' } });
  assert.deepEqual(moved.import_metadata.booking.duration_selection, receipt);
  assert.equal(moved.import_metadata.booking.profile.phases[0].key, 'care');
  assert.equal(moved.import_metadata.booking.profile.phases[0].duration_minutes, 45);
  const cancelled = await f.reserve({ existingAppointmentId: saved.id_cita, appointmentValues: { estado: 'cancelada' } });
  assert.deepEqual(cancelled.import_metadata.booking.duration_selection, receipt);
  const reopened = await f.reserve({ existingAppointmentId: saved.id_cita, appointmentValues: { estado: 'pendiente' } });
  assert.deepEqual(reopened.import_metadata.booking.duration_selection, receipt);
  await assert.rejects(f.reserve({ existingAppointmentId: saved.id_cita, appointmentValues: { fin: '2030-01-07T11:00:00Z' },
    durationSelection: { duration_minutes: 60 } }), { code: 'booking_duration_locked' });
});

test('canonical v4 null steps freeze actual offsets, span and complete verified projection', async () => {
  const value = template(4, [phase('first', { installation_ids: [9], professionals: { mode: 'any', ids: [5], preferred_id: 5 } }),
    phase('second', { start_offset_minutes: 15, installation_ids: [10], professionals: { mode: 'any', ids: [6], preferred_id: 6 } })]);
  const f = fixture({ bookingProfile: value });
  const saved = await f.reserve({ capabilities, durationSelection: { phase_durations: { first: 40, second: 20 } },
    appointmentValues: { ...f.values, fin: '2030-01-07T09:40:00Z' } });
  assert.equal(saved.import_metadata.booking.capacity_fully_verified, true);
  assert.deepEqual(saved.import_metadata.booking.profile.phases.map(row => row.start_offset_minutes), [0, 15]);
  assert.equal(bookingSegments(saved, f.state.occupancies).length, 2);
  assert.deepEqual(value.phases.map(row => row.duration_minutes), [null, null]);
});

test('duration cannot bypass physical occupancy and rejected choices never persist', async () => {
  const f = fixture({ bookingProfile: template() });
  await f.reserve({ durationSelection: { duration_minutes: 45 }, appointmentValues: { ...f.values, fin: '2030-01-07T09:45:00Z' } });
  await assert.rejects(f.reserve({ durationSelection: { duration_minutes: 45 },
    appointmentValues: { ...f.values, paciente_id: 2, fin: '2030-01-07T09:45:00Z' } }), { code: 'booking_unavailable' });
  assert.equal(f.state.persists, 1);
  await assert.rejects(f.reserve({ durationSelection: { duration_minutes: 45 }, appointmentValues: f.values }), { code: 'booking_duration_locked' });
  assert.equal(f.state.persists, 1);
});

function availabilityHandlerFixture(value = template(), query = {}) {
  const f = fixture({ bookingProfile: value });
  const filename = require.resolve('../../controllers/disponibilidad.controller'), actualRequire = createRequire(filename);
  const exported = {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports: exported, console, Date, Map, Set, Promise,
    require: name => name === '../../models' ? f.db : name === 'express-async-handler' ? fn => fn
      : name === '../lib/access-policy' ? { assertUserCanAccessFeature: async () => {} }
        : name === '../services/treatmentBookingProfile.service' ? { ...profileService, bookingCapabilities: () => capabilities,
          requireOperationalProfile: (t, options) => profileService.requireOperationalProfile(t, { capabilities, ...options }) }
          : name === '../services/appointmentBookingAvailability.service' ? { ...actualRequire(name),
            searchTreatmentSlots: input => searchTreatmentSlots({ ...input, capabilities, now: new Date('2030-01-01') }) }
            : actualRequire(name),
  }, { filename });
  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  const request = { userData: { userId: 9 }, query: { clinica_id: '72', tratamiento_id: '3', doctor_id: '5', instalacion_id: '9',
    inicio_local: '2030-01-07T10:00', fecha_local: '2030-01-07', duration_minutes: '45', limit: '2', ...query } };
  return { f, request, response, run: (name, patch = {}) => exported[name]({ ...request, query: { ...request.query, ...patch } }, response) };
}

test('actual HTTP exact check, treatment search and day grid use chosen duration with no legacy default', async () => {
  for (const name of ['check', 'treatmentSlots', 'slots']) {
    const h = availabilityHandlerFixture();
    await h.run(name);
    assert.equal(h.response.statusCode, 200, name);
    if (name === 'check') assert.equal(h.response.body.available, true);
    else {
      assert.equal(h.response.body.duration_minutes ?? h.response.body.duracion_min, 45, name);
      assert(h.response.body.slots.length > 0, name);
      assert(h.response.body.slots.every(slot => new Date(slot.end_at) - new Date(slot.start_at) === 45 * 60000), name);
    }
    assert.equal(h.f.state.persists, 0);
  }
  const grid = availabilityHandlerFixture();
  await grid.run('grid', { dates: ['2030-01-07', '2030-01-08'], mode: 'doctor', column_ids: [5], peer_instalacion_ids: [9] });
  assert.equal(grid.response.statusCode, 200);
  assert.equal(grid.response.body.duracion_min, 45);
  assert.equal(grid.response.body.rows.length, 2);
  const gridSlots = row => row.slots || Object.values(row.slots_by_instalacion || {}).flat();
  assert(grid.response.body.rows.every(row => row.ok && gridSlots(row).length > 0));
  assert(grid.response.body.rows.flatMap(gridSlots).every(slot => new Date(slot.end_at) - new Date(slot.start_at) === 45 * 60000));
  const summary = availabilityHandlerFixture();
  await summary.run('summary', { dates: ['2030-01-07', '2030-01-08'] });
  assert.equal(summary.response.statusCode, 200);
  assert.equal(summary.f.state.persists, 0);
});

test('HTTP availability consumers all reject missing or malformed choices before resource reads', async () => {
  for (const name of ['check', 'treatmentSlots', 'slots', 'grid', 'summary']) {
    const missing = availabilityHandlerFixture(); delete missing.request.query.duration_minutes;
    await assert.rejects(missing.run(name, { dates: ['2030-01-07'], column_ids: [5], mode: 'doctor' }), { code: 'booking_duration_required' }, name);
    const invalid = availabilityHandlerFixture(template(), { duration_minutes: '45x' });
    await assert.rejects(invalid.run(name, { dates: ['2030-01-07'], column_ids: [5], mode: 'doctor' }), { code: 'booking_duration_invalid' }, name);
    assert.equal(invalid.f.state.calls.filter(([key]) => key === 'hours').length, 0);
  }
});

test('HTTP explicit phase choices reach treatment planner, while ordinary grid stays explicitly single-phase', async () => {
  const value = template(4, [phase('one'), phase('two', { start_offset_minutes: 15,
    installation_ids: [10], professionals: { mode: 'any', ids: [6], preferred_id: 6 } })]);
  const h = availabilityHandlerFixture(value);
  delete h.request.query.duration_minutes; delete h.request.query.doctor_id; delete h.request.query.instalacion_id;
  h.request.query.phase_durations = '{"one":40,"two":20}';
  await h.run('treatmentSlots'); assert.equal(h.response.body.duration_minutes, 40);
  assert(h.response.body.slots.length > 0);
  assert(h.response.body.slots.every(slot => slot.phases.length === 2));
  await h.run('check'); assert.equal(h.response.body.available, true);
  await assert.rejects(h.run('slots'), { code: 'booking_profile_use_treatment_slots' });
});

test('existing-cita HTTP preview and search use its frozen duration, not new catalog values', async () => {
  const h = availabilityHandlerFixture();
  const saved = await h.f.reserve({ durationSelection: { duration_minutes: 45 },
    appointmentValues: { ...h.f.values, fin: '2030-01-07T09:45:00Z' } });
  const original = h.f.db.Tratamiento.findByPk;
  h.f.db.Tratamiento.findByPk = async (...args) => ({ ...await original(...args), clinical_config: { booking_profile: template(1, [phase('different', { duration_minutes: 20 })]) } });
  delete h.request.query.duration_minutes;
  h.request.query.limit = '20';
  h.request.query.ignore_cita_id = String(saved.id_cita);
  h.request.query.fin_local = '2030-01-07T10:45';
  await h.run('check'); assert.equal(h.response.body.available, true);
  await h.run('treatmentSlots'); assert.equal(h.response.body.duration_minutes, 45);
  assert(h.response.body.slots.some(slot => slot.start_at === '2030-01-07T09:00:00.000Z'));
  await h.run('slots'); assert.equal(h.response.body.duracion_min, 45);
  await assert.rejects(h.run('check', { duration_minutes: '20' }), { code: 'booking_duration_locked' });
  await assert.rejects(h.run('check', { ignore_cita_id: 'missing' }), { code: 'booking_ignore_invalid' });
});

function createHandlerFixture(value = template(), runtime = capabilities) {
  const f = fixture({ bookingProfile: value }), effects = [];
  f.db.CitaPaciente.create = (values, { transaction }) => f.persist({ values, transaction });
  const controllerPath = require.resolve('../../controllers/citas.controller'), actualRequire = createRequire(controllerPath);
  const source = fs.readFileSync(controllerPath, 'utf8');
  const start = source.indexOf('exports.createCita ='), end = source.indexOf('\n/**\n * Listar citas', start);
  const exported = {}, nothing = async () => {}, patient = { id_paciente: 1 };
  vm.runInNewContext(source.slice(start, end), { exports: exported, Date, console, require: actualRequire, db: f.db,
    ...profileService, bookingCapabilities: () => runtime,
    requireOperationalProfile: (t, options) => profileService.requireOperationalProfile(t, { capabilities: runtime, ...options }),
    mutateAppointmentBooking: input => actualRequire('../services/appointmentBookingCommand.service').mutateAppointmentBooking({ ...input, capabilities: runtime }),
    asyncHandler: fn => fn, normalizePatientLanguage: () => {}, CITA_ESTADOS_VALIDOS: new Set(['pendiente', 'completada']),
    Clinica: { findOne: async () => f.clinic }, Tratamiento: f.db.Tratamiento, CitaPaciente: f.db.CitaPaciente,
    assertAppointmentManageAccess: nothing, resolveClinicTimezone: () => 'Europe/Madrid', parsePositiveInt: value => Number(value) || null,
    findPacienteByIdentifier: async () => patient, actorCanReadPatientSensitive: async () => true,
    parseBool: value => value === true, cleanOptionalString: value => value || null,
    normalizeAdditionalStaff: () => [], normalizeAppointmentNotificationSuppression: () => null, parsePlainObject: value => value || {},
    checkDisponibilidadCanonica: async () => { effects.push('legacy'); return { resourceConflicts: [], legacyConflicts: [], canForce: false }; },
    findOrCreatePaciente: async () => { effects.push('patient'); return patient; },
    applyExplicitPatientLanguage: nothing, createAppointmentWithPatientLanguage: () => { throw Error('variable duration fell through to legacy'); },
    recordCreatedAppointmentLead: async () => null, enqueueCreatedAppointmentCrmSignals: nothing,
    appointmentAutomationV2Runtime: { enqueueExecutionForCita: nothing, syncScheduledTriggersForCita: nothing },
    ensureConsentPackageAndAutomation: nothing, processAppointmentLeadMilestones: nothing,
    patientDirectionService: { handleAppointmentChange: nothing }, Paciente: {}, LeadIntake: {}, Campana: null,
    Instalacion: { findByPk: async () => null },
    attachFlowSummaryToCitas: nothing, attachUnreadCountsToCitas: nothing, attachAppointmentProgramContexts: nothing,
    consentimientosService: { attachConsentSummaryToCitas: nothing }, attachResolvedAppointmentPricesToCitas: () => {},
    emitAppointmentSocketEvent: () => {}, protectAppointmentsForRequest: async (req, row) => row,
    sendAppointmentAccessPolicyError: () => false,
  }, { filename: controllerPath });
  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  const request = { userData: { userId: 9 }, body: { ...f.values, paciente: { id_paciente: 1 },
    duration_minutes: 45, tipo_cita: 'continuacion' } };
  delete request.body.fin;
  return { f, effects, response, request, create: () => exported.createCita(request, response) };
}

test('actual create HTTP handler derives end from explicit duration and freezes through real command', async () => {
  const h = createHandlerFixture(); await h.create();
  assert.equal(h.response.statusCode, 201);
  assert.equal(new Date(h.response.body.fin).toISOString(), '2030-01-07T09:45:00.000Z');
  assert.deepEqual(h.response.body.import_metadata.booking.duration_selection, { duration_minutes: 45, phase_durations: { care: 45 } });
  assert.equal(h.f.state.commits, 1); assert.equal(h.f.state.persists, 1);
  assert.deepEqual(h.effects, ['patient']);
  const legacy = createHandlerFixture();
  delete legacy.request.body.duration_minutes; legacy.request.body.duracion_min = 45;
  await legacy.create(); assert.equal(legacy.response.statusCode, 201);
  assert.equal(legacy.response.body.import_metadata.booking.profile.phases[0].duration_minutes, 45);
});

test('create HTTP handler rejects null, missing, disabled and incompatible duration before any patient/write', async () => {
  for (const [value, runtime, body, expected] of [
    [template(), capabilities, { duration_minutes: null }, 'booking_duration_invalid'],
    [template(), capabilities, { fin: '2030-01-07T09:30:00Z', duration_minutes: undefined }, 'booking_duration_invalid'],
    [template(), capabilities, { fin: '2030-01-07T09:30:00Z' }, 'booking_duration_locked'],
    [null, capabilities, {}, 'booking_profile_missing'],
    [template(), { simple: false, multi: false }, {}, 'booking_profile_runtime_unavailable'],
    [template(), capabilities, { historical_registration: true, inicio: '2020-01-07T09:00:00Z' }, 'booking_duration_unsupported'],
  ]) {
    const h = createHandlerFixture(value, runtime); Object.assign(h.request.body, body);
    await h.create(); assert.equal(h.response.body.code, expected);
    assert.equal(h.f.state.persists, 0); assert.deepEqual(h.effects, []);
  }
  const missing = createHandlerFixture(); delete missing.request.body.duration_minutes; missing.request.body.fin = '2030-01-07T09:30:00Z';
  await missing.create(); assert.equal(missing.response.body.code, 'booking_duration_required');
  assert.deepEqual(missing.effects, []);
});

test('actual create HTTP handler accepts explicit multiphase durations and rejects omitted or fixed-phase override', async () => {
  const value = template(4, [phase('one'), phase('two', { start_offset_minutes: 15, installation_ids: [10],
    professionals: { mode: 'any', ids: [6], preferred_id: 6 } })]);
  const h = createHandlerFixture(value);
  delete h.request.body.duration_minutes; h.request.body.phase_durations = { one: 40, two: 20 };
  await h.create(); assert.equal(h.response.statusCode, 201);
  assert.equal(new Date(h.response.body.fin).toISOString(), '2030-01-07T09:40:00.000Z');
  assert.equal(h.response.body.import_metadata.booking.profile.version, 4);
  const incomplete = createHandlerFixture(value); incomplete.request.body.phase_durations = { one: 40 };
  await incomplete.create(); assert.equal(incomplete.response.body.code, 'booking_duration_required');
  assert.equal(incomplete.f.state.persists, 0);
  const fixed = createHandlerFixture(template(1, [phase('care', { duration_minutes: 30 })]));
  await fixed.create(); assert.equal(fixed.response.body.code, 'booking_duration_locked');
});

test('real booking catalogue exposes exact pending keys without mutating the variable template', async () => {
  const f = fixture({ bookingProfile: template() });
  const value = template(1, [phase(undefined, { key: undefined })]); // Normalizer supplies the stable phase key.
  const row = { ...treatment(value), clinica_id: 72, origen: 'clinica' };
  f.db.Tratamiento.findAll = async () => [row];
  const filename = require.resolve('../../controllers/tratamientos.controller'), actualRequire = createRequire(filename);
  const source = fs.readFileSync(filename, 'utf8');
  const start = source.indexOf('exports.getTratamientos ='), end = source.indexOf('// Crear tratamiento', start);
  const exported = {};
  vm.runInNewContext(source.slice(start, end), { exports: exported, Date, Set, db: f.db, Op: f.db.Sequelize.Op,
    asyncHandler: fn => fn, Tratamiento: f.db.Tratamiento, Clinica: f.db.Clinica,
    toIntOrNull: value => Number(value) || null, resolveGroupIdForClinicId: async () => 2,
    resolveClinicDisciplines: async () => ['general'], expandTreatmentDisciplineCodes: value => value,
    catalogDto: actualRequire('../lib/treatment-catalog-contract').catalogDto,
    require: name => name === '../lib/appointment-booking-catalog'
      ? { individualBookingEligible: (t, clinicId, options) => individualBookingEligible(t, clinicId, { ...options, capabilities }) }
      : actualRequire(name),
  }, { filename });
  const response = { json(value) { this.body = value; return this; } };
  await exported.getTratamientos({ userData: { userId: 9 }, query: { clinica_id: '72', booking: 'true' } }, response);
  assert.equal(response.body.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body[0].duration_requirements)), { required: true, input: 'duration_minutes',
    phases: [{ key: 'phase_1', label: 'Atención ficticia' }] });
  assert.equal(response.body[0].clinical_config.booking_profile.phases[0].duration_minutes, null);
  assert.equal(row.clinical_config.booking_profile.phases[0].key, undefined);
});

test('editing preview rejects foreign, wrong-treatment, absent and incomplete snapshots without catalog fallback', async () => {
  for (const [patch, expected] of [
    [{ clinica_id: 73 }, 'appointment_not_found'], [{ tratamiento_id: 999 }, 'appointment_not_found'],
    [{ import_metadata: { booking: { profile: template() } } }, 'booking_profile_invalid'],
    [{ import_metadata: { booking: {} } }, 'booking_profile_invalid'],
    [{ import_metadata: 'invalid-json' }, 'booking_profile_invalid'],
  ]) {
    const h = availabilityHandlerFixture();
    const saved = await h.f.reserve({ durationSelection: { duration_minutes: 45 },
      appointmentValues: { ...h.f.values, fin: '2030-01-07T09:45:00Z' } });
    Object.assign(h.f.state.appointments[0], patch);
    delete h.request.query.duration_minutes;
    await assert.rejects(h.run('treatmentSlots', { ignore_cita_id: String(saved.id_cita) }), { code: expected });
    assert.equal(h.f.state.persists, 1);
  }
});
