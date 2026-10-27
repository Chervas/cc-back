'use strict';

// A transport for the shared agenda UI, not a second scheduler or a purchased
// program. All reservations still pass through the native series command.
const replay = require('../lib/voucher-booking-replay');
const { resolveClinicTimezone } = require('../lib/availability-calendar');
const { civilLocal } = require('../lib/program-reschedule');
const { loadScopedTreatment, requireOperationalProfile, bookingCapabilities } = require('./treatmentBookingProfile.service');
const { bookingProfileDurationMinutes, normalizeBookingProfile } = require('../lib/booking-profile');
const { loadBookingContext, solutionsForCalendar } = require('./appointmentBookingAvailability.service');
const { solveBookingProfile } = require('../lib/booking-profile-solver');
const { addVirtualBusy } = require('./patientProgramBooking.service');
const fail = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode }); };
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

function createService({ db = require('../../models'), concepts = require('./economicConcepts.service').createService({ db }),
  voucherBooking = require('./patientVoucherAppointments.service'), conceptBooking = require('./budgetConceptAppointments.service'),
  canAccess = input => require('../lib/access-policy').canUserAccessFeature(input), replayEnabled = () => replay.enabled(),
  now = () => new Date(), draftPreview = require('./patientProgramDraftPreview.service').preview } = {}) {
  async function identity(input, writing = false, transaction = null) {
    const actorId = positive(input.actorId), clinicId = positive(input.clinicId), patientId = positive(input.patientId);
    if (!actorId) fail('unauthenticated', 'Inicia sesión para continuar.', 401);
    if (!clinicId || !patientId) fail('agenda_origin_scope_required', 'Indica el paciente y la clínica de esta planificación.', 400);
    for (const featureKey of ['patients.view', writing ? 'appointments.manage' : 'appointments.view']) {
      if (!await canAccess({ actorId, clinicId, featureKey })) fail('access_policy_forbidden', 'No tienes permiso para esta planificación.', 403);
    }
    const origin = input.kind === 'budget_concept' ? await db.EconomicBudget.findOne({ where: { public_id: input.publicId, clinic_id: clinicId, patient_id: patientId }, transaction })
      : input.kind === 'voucher' ? await db.PatientVoucher.findOne({ where: { public_id: input.publicId, clinic_id: clinicId, patient_id: patientId }, transaction }) : null;
    if (!origin) fail('agenda_origin_not_found', 'No se encuentra este origen en el paciente y la clínica indicados.', 404);
    const patient = await db.Paciente.findByPk(patientId, { transaction });
    if (!patient || Number(patient.clinica_id) !== clinicId && !(db.PacienteClinica && await db.PacienteClinica.findOne({ where: { paciente_id: patientId, clinica_id: clinicId }, transaction }))) fail('patient_not_found', 'Paciente no encontrado en esta clínica.', 404);
    return { origin, actorId, clinicId, patientId };
  }
  async function load(input, writing = false, transaction = null) {
    const context = await identity(input, writing, transaction), { origin, actorId, clinicId, patientId } = context;
    let treatmentId, pending, reserved = [], revisionEvidence, source, title;
    if (input.kind === 'budget_concept') {
      const result = await concepts.bookingSource({ publicId: input.publicId, lineKey: input.lineKey, actorId,
        expectedVersion: input.payload?.expected_version, transaction });
      if (result.line.program_id || result.progress.fulfillment_voucher_id) fail('agenda_origin_planner_mismatch', 'Abre el planificador de su bono o programa.');
      treatmentId = positive(result.line.treatment_id); pending = result.progress.pending;
      source = { kind: 'budget_concept', budget_id: origin.public_id, line_key: result.line.key, version: Number(origin.current_version), clinic_id: clinicId, patient_id: patientId };
      reserved = result.progress.appointments.filter(row => !row.performed && !['cancelada', 'reprogramada', 'no_asistio'].includes(row.status))
        .map(row => ({ appointment_id: row.id, start_at: new Date(row.start_at).toISOString(), end_at: new Date(row.end_at).toISOString(), status: row.status }));
      revisionEvidence = { progress: { contracted: result.progress.contracted, used: result.progress.used, cancelled: result.progress.cancelled,
        pending, concept_revision: result.progress.concept_revision }, appointments: result.progress.appointments };
      title = result.line.name;
    } else {
      if (origin.source_system === 'treatment_program') fail('agenda_origin_planner_mismatch', 'Este programa conserva su planificador por sesiones.');
      const appointments = await db.CitaPaciente.findAll({ where: { voucher_id: origin.id }, order: [['id_cita', 'ASC']], transaction });
      if (appointments.some(row => Number(row.clinica_id) !== clinicId || Number(row.paciente_id) !== patientId)) fail('agenda_origin_sessions_review', 'El historial vinculado a este bono requiere revisión.');
      const movements = await db.PatientVoucherMovement.findAll({ where: { voucher_id: origin.id }, order: [['id', 'ASC']], transaction });
      const consumed = new Set(movements.filter(row => row.movement_type === 'consumption').map(row => Number(row.appointment_id)));
      reserved = appointments.filter(row => !consumed.has(Number(row.id_cita)) && row.estado !== 'cancelada')
        .map(row => ({ appointment_id: Number(row.id_cita), start_at: new Date(row.inicio).toISOString(), end_at: new Date(row.fin).toISOString(), status: row.estado }));
      pending = Math.max(0, Math.floor(Number(origin.available_units)) - reserved.length); treatmentId = positive(origin.treatment_id);
      source = { kind: 'voucher', voucher_id: origin.public_id, clinic_id: clinicId, patient_id: patientId };
      revisionEvidence = { status: origin.status, available_units: String(origin.available_units), expires_at: origin.expires_at,
        appointments: appointments.map(row => ({ id: Number(row.id_cita), status: row.estado, start_at: row.inicio, end_at: row.fin, provisional: row.es_provisional })),
        movements: movements.map(row => ({ id: String(row.id), units: String(row.units), type: row.movement_type, appointment_id: row.appointment_id })) };
      title = origin.name;
    }
    if (!treatmentId || !Number.isSafeInteger(pending) || pending < 0) fail('agenda_origin_sessions_review', 'El tratamiento o sus sesiones pendientes requieren revisión.');
    const clinic = await db.Clinica.findByPk(clinicId, { transaction });
    if (!clinic) fail('clinic_not_found', 'Clínica no encontrada.', 404);
    const timezone = resolveClinicTimezone(clinic);
    const treatment = await loadScopedTreatment({ db, treatmentId, clinic, transaction });
    const resources = await voucherBooking.seriesCoordinator.resourcesForClinic(clinicId, transaction);
    let profile = requireOperationalProfile(treatment, { allowMissingDuration: true }), legacy = !profile;
    if (legacy) {
      // This mirrors the legacy command's explicit choice of any active room
      // and professional. It is a view of real resources, never a catalog write.
      if (!resources.installations.length || !resources.doctors.length) fail('agenda_origin_resources_required', 'Configura una sala y un profesional para planificar este tratamiento.');
      profile = normalizeBookingProfile({ version: 1, phases: [{ key: 'visit', label: treatment.nombre || title,
        duration_minutes: positive(treatment.duracion_min), installation_ids: resources.installations.map(row => Number(row.id)),
        professionals: { mode: 'any', ids: resources.doctors.map(row => Number(row.id)) } }] }, { allowIncomplete: true });
    }
    const snapshot = { kind: 'series', name: title || treatment.nombre, cadence: null, appointments: [],
      sha256: replay.hash({ source, treatment_id: treatmentId, profile, legacy }) };
    const sessions = Array.from({ length: Math.min(pending, 30) }, (_, index) => ({ key: `pending_${index + 1}`,
      label: `Sesión pendiente ${index + 1}`, position: index, scheduling_status: 'pending', offset_days: null,
      treatments: [{ id: treatmentId, name: treatment.nombre }], booking_profile: profile,
      duration_minutes: bookingProfileDurationMinutes(profile), duration_required: profile.phases.some(phase => phase.duration_minutes == null),
      requires_manual_date: true, appointment_id: null, start_at: null, end_at: null }));
    snapshot.appointments = sessions;
    const allowed = input.kind === 'budget_concept' || ['active', 'pending'].includes(origin.status) && (!origin.expires_at || new Date(origin.expires_at) > now());
    return { ...context, source, treatment, profile, legacy, clinic, timeZone: timezone, snapshot, sessions, reserved, pending,
      can_schedule: allowed && pending > 0, revision: replay.hash(JSON.parse(JSON.stringify({ source, snapshot: snapshot.sha256, revisionEvidence }))),
      resourceOptions: { installations: resources.installations.map(row => ({ id: Number(row.id), name: row.name })),
        professionals: resources.doctors.map(row => ({ id: Number(row.id), name: row.name })) } };
  }
  function dto(plan) {
    return { source: plan.source, booking_replay_supported: replayEnabled(), clinic_id: plan.clinicId, name: plan.snapshot.name,
      snapshot_sha256: plan.snapshot.sha256, plan_revision: plan.revision, timezone: plan.timeZone, kind: 'series',
      scheduling_mode: 'manual', automatic_scheduling_available: false, can_schedule: plan.can_schedule,
      pending_count: plan.pending, unproposed_count: Math.max(0, plan.pending - plan.sessions.length), resource_options: plan.resourceOptions,
      reserved_appointments: plan.reserved, sessions: plan.sessions, resume: null, resume_options: [], can_resume: false };
  }
  async function read(input) { return dto(await load(input)); }
  async function contextFor(plan, sessions, start, end) {
    const profile = { version: Math.max(...sessions.map(row => row.booking_profile.version)),
      phases: sessions.flatMap(row => row.booking_profile.phases) };
    return loadBookingContext({ db, clinic: plan.clinic, profile, start, end, occupancyEnabled: true,
      patientId: plan.patientId, includeDiagnosticLabels: true });
  }
  async function propose(input) {
    const plan = await load(input);
    if (!plan.can_schedule) fail('agenda_origin_not_schedulable', 'Este origen no admite nuevas citas.');
    if (input.payload?.snapshot_sha256 != null && input.payload.snapshot_sha256 !== plan.snapshot.sha256
      || input.payload?.plan_revision != null && input.payload.plan_revision !== plan.revision) fail('agenda_origin_plan_changed', 'Las sesiones o el tratamiento han cambiado. Actualiza la planificación.');
    return draftPreview({ plan, payload: input.payload, actorId: plan.actorId, now: now(), contextFor, dto,
      solve: solveBookingProfile, slots: solutionsForCalendar, addVirtualBusy,
      supportIds: () => [], supportAvailable: () => true, assessment: () => null });
  }
  async function availabilityGrid(input) {
    if (!bookingCapabilities().simple) fail('booking_profile_runtime_unavailable', 'La disponibilidad operativa aún no está habilitada en este entorno.', 503);
    const plan = await load(input);
    if (!plan.can_schedule) fail('agenda_origin_not_schedulable', 'Este origen no admite nuevas citas.');
    if (input.payload?.mode != null && input.payload.mode !== 'initial') fail('agenda_origin_planner_mismatch', 'Este origen conserva su planificación de sesiones pendientes.');
    return require('./programAgendaAvailability.service').availabilityGrid({ db, plan, payload: input.payload,
      eligible: plan.sessions, revision: plan.revision, actorId: plan.actorId, now: now(), contextFor, addVirtualBusy });
  }
  function seriesPayload(input) {
    const body = input.payload || {}, sessions = body.sessions;
    replay.key(body.request_key); replay.sha(body.snapshot_sha256); replay.sha(body.plan_revision);
    if (!Array.isArray(sessions) || !sessions.length || sessions.length > 30 || new Set(sessions.map(row => row?.key)).size !== sessions.length
      || sessions.some(row => !row || !/^pending_[1-9]\d*$/.test(row.key) || typeof row.start_at !== 'string'
        || Object.keys(row).some(key => !['key', 'start_at', 'selections', 'duration_minutes', 'phase_durations', 'priority_acknowledged'].includes(key)))) fail('agenda_origin_sessions_invalid', 'Conserva las fechas y recursos de las sesiones elegidas.', 400);
    const result = { start_at: sessions[0].start_at, count: sessions.length,
      starts_by_sequence: Object.fromEntries(sessions.map((row, index) => [String(index + 1), row.start_at])),
      booking_selections_by_sequence: Object.fromEntries(sessions.map((row, index) => [String(index + 1), row.selections || {}])),
      duration_selections_by_sequence: Object.fromEntries(sessions.map((row, index) => [String(index + 1), {
        ...(row.duration_minutes != null ? { duration_minutes: row.duration_minutes } : {}),
        ...(row.phase_durations ? { phase_durations: row.phase_durations } : {}) }])),
      booking_priority_acknowledgements_by_sequence: Object.fromEntries(sessions.map((row, index) => [String(index + 1), row.priority_acknowledged === true])),
      ...(sessions[0].duration_minutes != null ? { duration_minutes: sessions[0].duration_minutes } : {}),
      ...(sessions[0].phase_durations ? { phase_durations: sessions[0].phase_durations } : {}),
      ...(input.kind === 'budget_concept' ? { expected_version: body.expected_version } : {}) };
    return result;
  }
  async function book(input) {
    const payload = seriesPayload(input), context = await identity(input, true), body = input.payload;
    const binding = replay.hash({ source: { kind: input.kind, public_id: input.publicId, line_key: input.lineKey || null },
      clinic_id: context.clinicId, patient_id: context.patientId, actor_id: context.actorId, request: body });
    const native = input.kind === 'budget_concept' ? conceptBooking : voucherBooking;
    const call = { publicId: input.publicId, lineKey: input.lineKey, actorId: context.actorId, payload };
    // Called by the native command while its patient mutex is held. The same
    // selected view must still exist immediately before prepare and persistence.
    call.validateAgenda = async transaction => {
      const current = await load(input, true, transaction);
      if (!current.can_schedule || current.revision !== body.plan_revision || current.snapshot.sha256 !== body.snapshot_sha256
        || body.sessions.some(row => !current.sessions.some(session => session.key === row.key))) fail('agenda_origin_plan_changed', 'Las sesiones o el tratamiento han cambiado. Actualiza la planificación.');
    };
    if (replayEnabled()) { payload.booking_request_key = body.request_key; payload.agenda_request_sha256 = binding; }
    let prepared = replayEnabled() ? await native.recover(call) : null;
    if (!prepared) {
      const plan = await load(input, true);
      if (!plan.can_schedule || body.snapshot_sha256 !== plan.snapshot.sha256 || body.plan_revision !== plan.revision
        || body.sessions.some(row => !plan.sessions.some(session => session.key === row.key))) fail('agenda_origin_plan_changed', 'Las sesiones o el tratamiento han cambiado. Actualiza la planificación.');
      const ordered = body.sessions.map(row => plan.sessions.find(session => session.key === row.key).position);
      if (ordered.some((position, index) => index && position <= ordered[index - 1])) fail('agenda_origin_sessions_invalid', 'Conserva el orden de las sesiones.', 400);
      if (plan.legacy) {
        const choices = body.sessions.map(row => row.selections?.visit);
        if (choices.some(choice => !positive(choice?.doctor_id) || !positive(choice?.installation_id))) fail('agenda_origin_resources_mismatch', 'Selecciona una sala y un profesional para cada cita.', 422);
        delete payload.booking_selections_by_sequence;
        payload.resources_by_sequence = Object.fromEntries(choices.map((choice, index) => [String(index + 1), choice]));
      }
      if (replayEnabled()) prepared = await native.preview(call);
    }
    if (prepared) {
      if (!prepared.booking_request_key || prepared.has_conflicts) fail('agenda_origin_unavailable', 'Revisa la disponibilidad antes de reservar.');
      payload.booking_request_key = prepared.booking_request_key; payload.booking_request_sha256 = prepared.booking_request_sha256;
      if (prepared.payload) Object.assign(payload, prepared.payload);
    }
    const receipt = await native.create(call);
    if (!Array.isArray(receipt.created) || receipt.created.length !== body.sessions.length) fail('agenda_origin_receipt_invalid', 'No se puede verificar el resultado. Revisa la agenda antes de reservar otra vez.', 503);
    const source = input.kind === 'budget_concept' ? { kind: input.kind, budget_id: input.publicId, line_key: input.lineKey, version: body.expected_version,
      clinic_id: context.clinicId, patient_id: context.patientId } : { kind: input.kind, voucher_id: input.publicId, clinic_id: context.clinicId, patient_id: context.patientId };
    return { source, booking_replay_supported: replayEnabled(), data: { source, request_key: body.request_key,
      snapshot_sha256: body.snapshot_sha256, plan_revision: body.plan_revision, replayed: receipt.replayed === true,
      ...(receipt.booking_request_key ? { booking_request_key: receipt.booking_request_key, booking_request_sha256: receipt.booking_request_sha256 } : {}),
      sessions: receipt.created.map((row, index) => ({ key: body.sessions[index].key, appointment_id: Number(row.id),
        start_at: new Date(row.start_at).toISOString(), end_at: new Date(row.end_at).toISOString(), action: 'created' })) } };
  }
  return { read, propose, availabilityGrid, book };
}
let singleton;
const current = () => singleton ||= createService();
module.exports = { createService, ...Object.fromEntries(['read', 'propose', 'availabilityGrid', 'book'].map(method => [method, input => current()[method](input)])) };
