'use strict';

const { domainError } = require('../lib/treatmentPrograms.contract');
const { programBookingEnabled, bookingRequest, seriesIssues } = require('../lib/program-booking');
const { operationalSnapshot } = require('../lib/economicProgramSnapshot');
const { resolveClinicTimezone, formatDateLocal } = require('../lib/availability-calendar');
const { resolveLocalInstant } = require('../lib/voucher-schedule-calendar');
const { addDays } = require('../lib/personal-schedule-recurring');
const { loadBookingContext, resolveInstallationKeys, solutionsForCalendar } = require('./appointmentBookingAvailability.service');
const { lockBookingResources, mutateAppointmentBooking } = require('./appointmentBookingCommand.service');
const { solveBookingProfile, occupancyForSolution } = require('../lib/booking-profile-solver');
const { assertPriorityAcknowledgement, loadScopedTreatment } = require('./treatmentBookingProfile.service');
const { equipmentIds } = require('../lib/booking-equipment');
const { schedulingState, planRevision, resumeInfo, resumeSessions, resumeInput, assertRevision, createSeriesContext } = require('../lib/program-replan');
const { additionalStaffSnapshot } = require('../lib/appointment-additional-staff');
const { installationAllowsStaff } = require('../lib/installation-professionals');
const { isFree } = require('../lib/booking-profile-solver');
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = (code, message, details, status = 409) => { throw domainError(status, code, message, details); };

function addVirtualBusy(context, solution, staff = []) {
  const occupancy = occupancyForSolution(solution, context.installationKeys);
  for (const row of occupancy) {
    const targets = row.resource_kind === 'equipment' ? [context.equipment?.get(Number(row.resource_key.split(':')[1]))]
      : row.doctor_id ? [context.doctors.get(row.doctor_id)]
      : [...context.installations].filter(([id]) => context.installationKeys.get(id) === row.resource_key).map(([, target]) => target);
    for (const target of new Set(targets)) if (target) target.busy.push({ start: row.start_at, end: row.end_at });
  }
  for (const id of staff) context.doctors.get(id)?.busy.push({ start: solution.start_at, end: solution.end_at });
  context.patientBusy.push({ start: solution.start_at, end: solution.end_at });
}

function supportIds(session) {
  const snapshot = additionalStaffSnapshot(session.appointment);
  if (json(session.appointment?.import_metadata || {})?.additional_staff && !snapshot) fail('program_support_invalid', 'Revisa el personal de apoyo de esta cita antes de continuar.');
  return snapshot?.ids || [];
}
function supportAvailable(context, solution, staff) {
  return staff.every(id => isFree(context.doctors.get(id), new Date(solution.start_at), new Date(solution.end_at)))
    && solution.phases.every(phase => !staff.length || installationAllowsStaff(context.installations.get(phase.installation_id), staff));
}
function previousAppointment(session) {
  const row = session.appointment;
  return row ? { id: Number(row.id_cita), status: row.estado, start_at: new Date(row.inicio).toISOString(), end_at: new Date(row.fin).toISOString() } : null;
}

function createPatientProgramBookingService({ db, enabled = programBookingEnabled, now = () => new Date() }) {
  function assertEnabled() { if (!enabled()) fail('program_booking_disabled', 'La reserva de programas aún no está habilitada en este entorno.', null, 503); }
  async function load({ publicId, clinicId, transaction = null, lock = false }) {
    assertEnabled();
    if (!Number.isSafeInteger(clinicId) || clinicId < 1) fail('program_clinic_required', 'Clínica no válida.', null, 400);
    const voucher = await db.PatientVoucher.findOne({ where: { public_id: publicId, clinic_id: clinicId, source_system: 'treatment_program' },
      transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!voucher) fail('program_purchase_not_found', 'Programa comprado no encontrado.', null, 404);
    const [budget, clinic, records] = await Promise.all([
      db.EconomicBudget.findOne({ where: { id: voucher.budget_id, clinic_id: clinicId, patient_id: voucher.patient_id }, transaction }),
      db.Clinica.findByPk(clinicId, { transaction, ...(lock ? { lock: transaction.LOCK.SHARE } : {}) }),
      db.PatientProgramSession.findAll({ where: { voucher_id: voucher.id }, order: [['position', 'ASC']], transaction,
        ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) }),
    ]);
    if (!budget || !clinic) fail('program_purchase_invalid', 'No se encuentra el presupuesto de este programa.');
    const version = await db.EconomicBudgetVersion.findOne({ where: { budget_id: budget.id, version_number: budget.current_version }, transaction });
    const line = json(version?.lines || []).find(item => item.key === voucher.budget_line_key);
    let accepted = budget.status === 'accepted';
    if (budget.status === 'partially_accepted') {
      const event = await db.EconomicBudgetEvent.findOne({ where: { budget_id: budget.id, version_number: budget.current_version, event_type: 'partially_accepted' }, order: [['id', 'DESC']], transaction });
      accepted = (json(event?.metadata || {})?.accepted_line_keys || []).includes(voucher.budget_line_key);
    }
    const snapshot = operationalSnapshot(line?.program_snapshot);
    if (Number(voucher.total_units) !== snapshot.appointments.length || records.some(row => row.snapshot_sha256 !== snapshot.sha256)) fail('program_purchase_changed', 'La composición comprada no coincide con sus sesiones. Revisa el presupuesto.');
    const ids = records.map(row => row.appointment_id).filter(Boolean);
    const appointments = ids.length ? await db.CitaPaciente.findAll({ where: { id_cita: { [db.Sequelize.Op.in]: ids },
      voucher_id: voucher.id, paciente_id: voucher.patient_id, clinica_id: clinicId }, transaction,
      ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) }) : [];
    const sessions = snapshot.appointments.map((definition, position) => {
      const record = records.find(row => row.session_key === definition.key);
      const appointment = appointments.find(row => Number(row.id_cita) === Number(record?.appointment_id));
      if (record?.appointment_id && !appointment) fail('program_session_inconsistent', 'Falta una cita del historial del programa.');
      const status = schedulingState(record, appointment);
      const scheduled = appointment && ['reserved', 'completed'].includes(status);
      return { ...definition, position, record, appointment, scheduling_status: status,
        start_at: scheduled ? new Date(appointment.inicio).toISOString() : null,
        end_at: scheduled ? new Date(appointment.fin).toISOString() : null };
    });
    return { voucher, budget, accepted, clinic, snapshot, sessions, timeZone: resolveClinicTimezone(clinic) };
  }
  function assertSchedulable(plan) {
    if (!plan.accepted || plan.voucher.status !== 'active'
      || (plan.voucher.expires_at && new Date(plan.voucher.expires_at) <= now())) fail('program_purchase_not_schedulable', 'El programa debe estar aceptado, activo y sin caducar.');
    // Partial acceptance activates only accepted lines in the canonical voucher
    // writer. No client checkbox or payment inference can activate this unit.
    const reserved = plan.sessions.filter(row => row.scheduling_status === 'reserved').length;
    if (Number(plan.voucher.available_units) < reserved) fail('program_units_inconsistent', 'Revisa las sesiones disponibles de este programa.');
  }
  function dto(plan) {
    const pending = plan.sessions.filter(row => ['pending', 'missed'].includes(row.scheduling_status)).length;
    const resume = resumeInfo(plan, now());
    const active = plan.voucher.status === 'active' && plan.accepted && (!plan.voucher.expires_at || new Date(plan.voucher.expires_at) > now());
    return { voucher_id: plan.voucher.public_id, clinic_id: Number(plan.voucher.clinic_id), name: plan.snapshot.name,
      snapshot_sha256: plan.snapshot.sha256, timezone: plan.timeZone, cadence: plan.snapshot.cadence,
      plan_revision: planRevision(plan), resume, can_resume: !!resume && !resume.blocked_reason && active,
      pending_count: pending, can_schedule: pending > 0 && active && !resume,
      sessions: plan.sessions.map(({ record, appointment, ...row }) => ({ ...row, appointment_id: appointment?.id_cita || null,
        previous_appointment: previousAppointment({ appointment }),
        phases: json(appointment?.import_metadata || {})?.booking?.phases || [] })) };
  }
  async function contextFor(plan, sessions, start, end, transaction = null, lock = false, ignoreAppointmentIds = []) {
    // Include support calendars in the single bulk read without making a person
    // assisting one session a mandatory participant of every other session.
    const profile = { version: 1, phases: sessions.flatMap(row => row.booking_profile.phases.map(phase => ({ ...phase,
      professionals: { ...phase.professionals, ids: [...new Set([...phase.professionals.ids, ...supportIds(row)])] } }))) };
    const installationIds = [...new Set(profile.phases.flatMap(row => row.installation_ids))];
    const doctorIds = [...new Set(profile.phases.flatMap(row => row.professionals.ids))];
    const machineIds = equipmentIds(profile);
    profile.version = machineIds.length ? 2 : 1;
    if (installationIds.length + doctorIds.length + machineIds.length > 100) fail('program_search_resources_too_many', 'Este conjunto utiliza demasiados recursos. Planifica menos sesiones a la vez.', null, 400);
    const mapping = await resolveInstallationKeys({ db, clinic: plan.clinic, installationIds, transaction, enabled: true });
    if (lock) {
      await lockBookingResources({ db, transaction, resourceKeys: [
        `patient:${plan.voucher.patient_id}`, ...profile.phases.flatMap(row => row.professionals.ids.map(id => `doctor:${id}`)),
        ...installationIds.map(id => mapping.keys.get(id)),
        ...machineIds.map(id => `equipment:${id}`),
      ] });
    }
    // One bounded bulk context per proposal/confirmation, never queries inside
    // the candidate loop. Only calendar intervals leave the availability layer.
    return loadBookingContext({ db, clinic: plan.clinic, profile, start, end, transaction, occupancyEnabled: true,
      installationMapping: mapping, patientId: plan.voucher.patient_id, ignoreAppointmentIds });
  }
  async function read(options) { return dto(await load(options)); }

  async function propose(options) {
    const plan = await load(options); assertSchedulable(plan);
    const payload = options.payload || {};
    const resume = resumeInput(payload);
    if (resume) assertRevision(plan, resume.expected_plan_revision);
    else if (resumeInfo(plan, now())) fail('program_resume_required', 'Retoma el programa para revisar juntas las sesiones pendientes y sus fechas.');
    const date = String(payload.from_date || '');
    const horizon = payload.days ?? 90;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(horizon) || horizon < 1 || horizon > 180) fail('program_search_invalid', 'Elige un día de inicio y un máximo de 180 días de búsqueda.', null, 400);
    const start = resolveLocalInstant(date, '00:00:00', plan.timeZone), endDate = addDays(date, horizon);
    if (formatDateLocal(start, plan.timeZone) !== date) fail('program_search_invalid', 'Fecha no válida.', null, 400);
    const end = resolveLocalInstant(endDate, '00:00:00', plan.timeZone);
    const pending = resume ? resumeSessions(plan, resume.replan_from_key, now()) : plan.sessions.filter(row => row.scheduling_status === 'pending');
    if (!pending.length) return { ...dto(plan), proposals: [], unproposed_count: 0 };
    const selectedKeys = payload.session_keys == null ? pending.slice(0, 30).map(row => row.key) : payload.session_keys;
    if (!Array.isArray(selectedKeys) || !selectedKeys.length || selectedKeys.length > 30 || new Set(selectedKeys).size !== selectedKeys.length
      || selectedKeys.some(key => !pending.some(row => row.key === key))) fail('program_search_invalid', 'Selecciona hasta treinta sesiones pendientes.', null, 400);
    const selected = pending.filter(row => selectedKeys.includes(row.key));
    const ignored = resume ? pending.filter(row => row.scheduling_status === 'reserved').map(row => Number(row.appointment.id_cita)) : [];
    const context = await contextFor(plan, resume ? pending : selected, start, end, null, false, ignored);
    const series = plan.sessions.map(row => ({ key: row.key,
      start_at: resume && pending.includes(row) ? null : row.start_at, end_at: resume && pending.includes(row) ? null : row.end_at }));
    const proposals = [];
    // Optional fixed proposals are rechecked, never trusted as reservations. This
    // lets the dialog ask for another day for one unit while retaining the rest.
    const fixed = payload.fixed_sessions || [];
    if (!Array.isArray(fixed) || fixed.length > 30 || new Set(fixed.map(row => row.key)).size !== fixed.length) fail('program_search_invalid', 'Revisa las fechas conservadas.', null, 400);
    for (const row of fixed) {
      const session = pending.find(item => item.key === row.key);
      if (!session || selectedKeys.includes(row.key)) fail('program_search_invalid', 'No se puede conservar y cambiar la misma sesión.', null, 400);
      const instant = new Date(row.start_at);
      if (!Number.isFinite(instant.getTime())) fail('program_search_invalid', 'Fecha conservada no válida.', null, 400);
      const finish = new Date(instant.getTime() + session.duration_minutes * 60000);
      Object.assign(series[session.position], { start_at: instant.toISOString(), end_at: finish.toISOString() });
      context.patientBusy.push({ start: instant, end: finish });
    }
    const first = series.find(row => row.start_at);
    const anchor = first ? formatDateLocal(new Date(first.start_at), plan.timeZone) : date;
    for (const session of selected) {
      const staff = supportIds(session);
      const sessionContext = staff.length ? { ...context, installations: new Map([...context.installations].map(([id, room]) => [id,
        installationAllowsStaff(room, staff) ? room : { ...room, windows: [] }])) } : context;
      let chosen = null;
      let earliest = date;
      if (!plan.snapshot.cadence && session.offset_days != null) earliest = [date, addDays(anchor, session.offset_days)].sort().at(-1);
      const days = [];
      for (let day = earliest; day < endDate; day = addDays(day, 1)) days.push(day);
      if (payload.direction === 'backward') days.reverse();
      for (const day of days) {
        if (chosen) break;
        const slots = solutionsForCalendar({ profile: session.booking_profile, context: sessionContext, date: day, days: 1,
          stepMinutes: 15, limit: 96, now: now() });
        for (const slot of slots) {
          if (!supportAvailable(context, slot, staff)) continue;
          const candidateSeries = series.map(row => row.key === session.key ? { ...row, start_at: slot.start_at, end_at: slot.end_at } : row);
          if (!seriesIssues(candidateSeries, plan.snapshot.cadence, plan.timeZone).length) { chosen = slot; break; }
        }
      }
      if (chosen) {
        addVirtualBusy(context, chosen, staff);
        Object.assign(series[session.position], { start_at: chosen.start_at, end_at: chosen.end_at });
      }
      proposals.push({ key: session.key, label: session.label, solution: chosen,
        previous_appointment: previousAppointment(session),
        reason: chosen ? null : 'No hay un hueco que respete la pauta en los días consultados.' });
    }
    return { ...dto(plan), proposals, unproposed_count: pending.length - selected.length };
  }

  async function book(options) {
    assertEnabled();
    const request = bookingRequest(options.payload);
    return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const plan = await load({ ...options, transaction, lock: true });
      const prior = await db.PatientProgramBookingRequest.findOne({ where: { voucher_id: plan.voucher.id, request_key: request.request_key }, transaction });
      if (prior) {
        if (prior.request_sha256 !== request.request_sha256) fail('program_booking_request_conflict', 'La referencia de reserva ya se utilizó con otras fechas.');
        return { ...json(prior.result), replayed: true };
      }
      assertSchedulable(plan);
      if (request.snapshot_sha256 !== plan.snapshot.sha256) fail('program_snapshot_changed', 'El programa ha cambiado. Actualiza el plan.');
      const resume = request.mode === 'resume';
      if (resume) assertRevision(plan, request.expected_plan_revision);
      else if (resumeInfo(plan, now())) fail('program_resume_required', 'Retoma el programa para revisar juntas las sesiones pendientes y sus fechas.');
      const eligible = resume ? resumeSessions(plan, request.replan_from_key, now()) : plan.sessions.filter(row => row.scheduling_status === 'pending');
      if (resume && (request.sessions.length !== eligible.length || eligible.some(row => !request.sessions.some(item => item.key === row.key)))) fail('program_resume_incomplete', 'Confirma todas las sesiones de la propuesta para conservar el orden y la pauta.');
      const selected = request.sessions.map(row => {
        const session = eligible.find(item => item.key === row.key);
        if (!session) fail('program_session_not_pending', 'Una sesión elegida ya está reservada o completada. Actualiza el plan.');
        if (Object.keys(row.selections).some(key => !session.booking_profile.phases.some(phase => phase.key === key))) fail('program_selection_invalid', 'La fase elegida no pertenece a esta cita.');
        const start = new Date(row.start_at), end = new Date(start.getTime() + session.duration_minutes * 60000);
        if (start <= now() || end - now() > 366 * 86400000) fail('program_booking_date_invalid', 'Reserva citas futuras, dentro del próximo año.');
        return { ...session, choice: row, start_at: start.toISOString(), end_at: end.toISOString() };
      }).sort((a, b) => a.position - b.position);
      const reserved = plan.sessions.filter(row => row.scheduling_status === 'reserved' && !selected.some(item => item.key === row.key)).length;
      if (selected.length + reserved > Number(plan.voucher.available_units)) fail('program_units_insufficient', 'No quedan suficientes sesiones sin reservar.');
      const series = plan.sessions.map(row => selected.find(item => item.key === row.key) || row).map(row => ({ key: row.key, start_at: row.start_at, end_at: row.end_at }));
      const issues = seriesIssues(series, plan.snapshot.cadence, plan.timeZone);
      if (issues.length) fail('program_cadence_conflict', 'Las fechas no respetan la pauta del programa.', { issues });
      // Validate scope for EVERY treatment in the immutable purchase, not just
      // the legacy primary-treatment projection used by older screens.
      for (const treatmentId of new Set(selected.flatMap(row => row.treatment_ids))) await loadScopedTreatment({ db, treatmentId, clinic: plan.clinic, transaction });
      const start = new Date(selected[0].start_at), end = new Date(selected.at(-1).end_at);
      const ignored = selected.filter(row => row.scheduling_status === 'reserved').map(row => Number(row.appointment.id_cita));
      const context = await contextFor(plan, selected, start, end, transaction, true, ignored);
      for (const session of selected) {
        const definition = plan.snapshot.appointments[session.position];
        session.record ||= await db.PatientProgramSession.create({ voucher_id: plan.voucher.id, session_key: session.key,
          position: session.position, snapshot_sha256: plan.snapshot.sha256, snapshot: { ...definition, program_cadence: plan.snapshot.cadence } }, { transaction });
      }
      const trustedProgramSeries = createSeriesContext({ transaction, plan, selected, series });
      const created = [];
      for (const session of selected) {
        const staff = supportIds(session);
        const solution = solveBookingProfile({ profile: session.booking_profile, ...context, start: new Date(session.start_at), selections: session.choice.selections });
        if (!solution || !supportAvailable(context, solution, staff) || context.patientBusy.some(busy => new Date(busy.start) < new Date(session.end_at) && new Date(busy.end) > new Date(session.start_at))) fail('program_booking_unavailable', 'Un hueco acaba de ocuparse. No se ha reservado ni movido ninguna cita de esta solicitud.', { key: session.key });
        assertPriorityAcknowledgement(solution, session.choice.priority_acknowledged);
        const record = session.record;
        const moving = session.scheduling_status === 'reserved';
        const previous = previousAppointment(session);
        const appointment = await mutateAppointmentBooking({ db, transaction, trustedProgramSeries, preparedContext: context,
          ...(moving ? { existingAppointmentId: session.appointment.id_cita } : { trustedProgramSession: record }),
          additionalStaffIds: staff,
          capabilities: { simple: true, multi: true }, selections: session.choice.selections,
          priorityAcknowledged: session.choice.priority_acknowledged,
          appointmentValues: moving ? { inicio: session.start_at, fin: session.end_at, estado: 'reprogramada', reschedule_reason: 'clinic_schedule', updated_by: options.actorId }
            : { clinica_id: plan.voucher.clinic_id, paciente_id: plan.voucher.patient_id, voucher_id: plan.voucher.id,
            tratamiento_id: session.treatment_ids[0], inicio: session.start_at, fin: session.end_at, estado: 'pendiente', tipo_cita: 'continuacion',
            titulo: `${plan.snapshot.name} · ${session.label}`.slice(0, 255), created_by: options.actorId, updated_by: options.actorId,
            source_system: 'treatment_program', source_reference: `program-session:${record.id}:${request.request_key}`.slice(0, 120),
            import_metadata: { automation_policy: 'hold', notification_suppression: { appointment_details: true, day_before: true, same_day: true } } },
          persist: ({ values, existing }) => existing ? existing.update(values, { transaction }) : db.CitaPaciente.create(values, { transaction }) });
        await record.update({ appointment_id: appointment.id_cita }, { transaction });
        await require('./appointmentActivity.service').recordAppointmentStatusChange({ appointment,
          previousStatus: moving ? previous.status : null, newStatus: appointment.estado, actorUserId: options.actorId,
          source: 'agenda', metadata: { program_session_key: session.key, program_action: moving ? 'rescheduled' : 'created',
            ...(previous ? { previous_appointment_id: previous.id, previous_start_at: previous.start_at, previous_end_at: previous.end_at } : {}),
            start_at: solution.start_at, end_at: solution.end_at }, transaction, eventModel: db.PatientOperationalEvent || null,
          recordUnchanged: moving && previous.start_at !== solution.start_at });
        addVirtualBusy(context, solution, staff);
        created.push({ key: session.key, appointment_id: appointment.id_cita, action: moving ? 'rescheduled' : 'created', previous_appointment: previous,
          start_at: solution.start_at, end_at: solution.end_at, phases: solution.phases });
      }
      const result = { voucher_id: plan.voucher.public_id, sessions: created, reminders_enabled: false, replayed: false };
      await db.PatientProgramBookingRequest.create({ voucher_id: plan.voucher.id, request_key: request.request_key,
        request_sha256: request.request_sha256, result, created_by: options.actorId }, { transaction });
      return result;
    });
  }
  return { read, propose, book };
}

// Existing voucher ledger remains the ONLY economic source of consumed units.
async function consumeProgramSession({ db, appointment, voucher, transaction, actorId }) {
  if (!programBookingEnabled()) return { consumed: false, reason: 'program_booking_disabled' };
  const session = await db.PatientProgramSession.findOne({ where: { voucher_id: voucher.id, appointment_id: appointment.id_cita }, transaction, lock: transaction.LOCK.UPDATE });
  if (!session || Number(appointment.clinica_id) !== Number(voucher.clinic_id) || Number(appointment.paciente_id) !== Number(voucher.patient_id)) fail('program_session_not_found', 'La cita no corresponde a una sesión de este programa.');
  if (session.consumption_movement_id) return { consumed: false, already_consumed: true, movement_id: String(session.consumption_movement_id) };
  if (appointment.estado !== 'completada' || voucher.status !== 'active' || Number(voucher.available_units) < 1) return { consumed: false, reason: 'program_session_not_consumable' };
  const movement = await db.PatientVoucherMovement.create({ voucher_id: voucher.id, movement_type: 'consumption', units: -1,
    appointment_id: appointment.id_cita, notes: `Sesión ${session.position + 1} del programa.`, occurred_at: new Date(), created_by: actorId }, { transaction });
  const remaining = Number(voucher.available_units) - 1;
  await voucher.update({ available_units: remaining, status: remaining === 0 ? 'consumed' : 'active' }, { transaction });
  await session.update({ consumption_movement_id: movement.id }, { transaction });
  return { consumed: true, consumed_units: 1, available_units: remaining, movement_id: String(movement.id), voucher_id: voucher.public_id };
}

let instance;
const service = () => instance || (instance = createPatientProgramBookingService({ db: require('../../models') }));
module.exports = { createPatientProgramBookingService, consumeProgramSession, addVirtualBusy,
  read: options => service().read(options), propose: options => service().propose(options), book: options => service().book(options) };
