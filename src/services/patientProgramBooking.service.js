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
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = (code, message, details, status = 409) => { throw domainError(status, code, message, details); };

function addVirtualBusy(context, solution) {
  const occupancy = occupancyForSolution(solution, context.installationKeys);
  for (const row of occupancy) {
    const targets = row.doctor_id ? [context.doctors.get(row.doctor_id)]
      : [...context.installations].filter(([id]) => context.installationKeys.get(id) === row.resource_key).map(([, target]) => target);
    for (const target of new Set(targets)) if (target) target.busy.push({ start: row.start_at, end: row.end_at });
  }
  context.patientBusy.push({ start: solution.start_at, end: solution.end_at });
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
      db.PatientProgramSession.findAll({ where: { voucher_id: voucher.id }, order: [['position', 'ASC']], transaction }),
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
      voucher_id: voucher.id, paciente_id: voucher.patient_id, clinica_id: clinicId }, transaction }) : [];
    const sessions = snapshot.appointments.map((definition, position) => {
      const record = records.find(row => row.session_key === definition.key);
      const appointment = appointments.find(row => Number(row.id_cita) === Number(record?.appointment_id));
      if (record?.appointment_id && !appointment) fail('program_session_inconsistent', 'Falta una cita del historial del programa.');
      return { ...definition, position, record, appointment,
        scheduling_status: record?.consumption_movement_id ? 'completed' : appointment && appointment.estado !== 'cancelada' ? 'reserved' : 'pending',
        start_at: appointment && appointment.estado !== 'cancelada' ? new Date(appointment.inicio).toISOString() : null,
        end_at: appointment && appointment.estado !== 'cancelada' ? new Date(appointment.fin).toISOString() : null };
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
    const pending = plan.sessions.filter(row => row.scheduling_status === 'pending').length;
    return { voucher_id: plan.voucher.public_id, clinic_id: Number(plan.voucher.clinic_id), name: plan.snapshot.name,
      snapshot_sha256: plan.snapshot.sha256, timezone: plan.timeZone, cadence: plan.snapshot.cadence,
      pending_count: pending, can_schedule: pending > 0 && plan.voucher.status === 'active' && plan.accepted
        && (!plan.voucher.expires_at || new Date(plan.voucher.expires_at) > now()),
      sessions: plan.sessions.map(({ record, appointment, ...row }) => ({ ...row, appointment_id: appointment?.id_cita || null,
        phases: json(appointment?.import_metadata || {})?.booking?.phases || [] })) };
  }
  async function contextFor(plan, sessions, start, end, transaction = null, lock = false) {
    const profile = { version: 1, phases: sessions.flatMap(row => row.booking_profile.phases) };
    const installationIds = [...new Set(profile.phases.flatMap(row => row.installation_ids))];
    const doctorIds = [...new Set(profile.phases.flatMap(row => row.professionals.ids))];
    if (installationIds.length + doctorIds.length > 100) fail('program_search_resources_too_many', 'Este conjunto utiliza demasiadas cabinas y profesionales. Planifica menos sesiones a la vez.', null, 400);
    const mapping = await resolveInstallationKeys({ db, clinic: plan.clinic, installationIds, transaction, enabled: true });
    if (lock) {
      await lockBookingResources({ db, transaction, resourceKeys: [
        `patient:${plan.voucher.patient_id}`, ...profile.phases.flatMap(row => row.professionals.ids.map(id => `doctor:${id}`)),
        ...installationIds.map(id => mapping.keys.get(id)),
      ] });
    }
    // One bounded bulk context per proposal/confirmation, never queries inside
    // the candidate loop. Only calendar intervals leave the availability layer.
    return loadBookingContext({ db, clinic: plan.clinic, profile, start, end, transaction, occupancyEnabled: true,
      installationMapping: mapping, patientId: plan.voucher.patient_id });
  }
  async function read(options) { return dto(await load(options)); }

  async function propose(options) {
    const plan = await load(options); assertSchedulable(plan);
    const payload = options.payload || {};
    const date = String(payload.from_date || '');
    const horizon = payload.days ?? 90;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(horizon) || horizon < 1 || horizon > 180) fail('program_search_invalid', 'Elige un día de inicio y un máximo de 180 días de búsqueda.', null, 400);
    const start = resolveLocalInstant(date, '00:00:00', plan.timeZone), endDate = addDays(date, horizon);
    if (formatDateLocal(start, plan.timeZone) !== date) fail('program_search_invalid', 'Fecha no válida.', null, 400);
    const end = resolveLocalInstant(endDate, '00:00:00', plan.timeZone);
    const pending = plan.sessions.filter(row => row.scheduling_status === 'pending');
    if (!pending.length) return { ...dto(plan), proposals: [], unproposed_count: 0 };
    const selectedKeys = payload.session_keys == null ? pending.slice(0, 30).map(row => row.key) : payload.session_keys;
    if (!Array.isArray(selectedKeys) || !selectedKeys.length || selectedKeys.length > 30 || new Set(selectedKeys).size !== selectedKeys.length
      || selectedKeys.some(key => !pending.some(row => row.key === key))) fail('program_search_invalid', 'Selecciona hasta treinta sesiones pendientes.', null, 400);
    const selected = pending.filter(row => selectedKeys.includes(row.key));
    const context = await contextFor(plan, selected, start, end);
    const series = plan.sessions.map(row => ({ key: row.key, start_at: row.start_at, end_at: row.end_at }));
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
      let chosen = null;
      let earliest = date;
      if (!plan.snapshot.cadence && session.offset_days != null) earliest = [date, addDays(anchor, session.offset_days)].sort().at(-1);
      const days = [];
      for (let day = earliest; day < endDate; day = addDays(day, 1)) days.push(day);
      if (payload.direction === 'backward') days.reverse();
      for (const day of days) {
        if (chosen) break;
        const slots = solutionsForCalendar({ profile: session.booking_profile, context, date: day, days: 1,
          stepMinutes: 15, limit: 96, now: now() });
        for (const slot of slots) {
          const candidateSeries = series.map(row => row.key === session.key ? { ...row, start_at: slot.start_at, end_at: slot.end_at } : row);
          if (!seriesIssues(candidateSeries, plan.snapshot.cadence, plan.timeZone).length) { chosen = slot; break; }
        }
      }
      if (chosen) {
        addVirtualBusy(context, chosen);
        Object.assign(series[session.position], { start_at: chosen.start_at, end_at: chosen.end_at });
      }
      proposals.push({ key: session.key, label: session.label, solution: chosen,
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
      const selected = request.sessions.map(row => {
        const session = plan.sessions.find(item => item.key === row.key);
        if (!session || session.scheduling_status !== 'pending') fail('program_session_not_pending', 'Una sesión elegida ya está reservada o completada. Actualiza el plan.');
        if (Object.keys(row.selections).some(key => !session.booking_profile.phases.some(phase => phase.key === key))) fail('program_selection_invalid', 'La fase elegida no pertenece a esta cita.');
        const start = new Date(row.start_at), end = new Date(start.getTime() + session.duration_minutes * 60000);
        if (start <= now() || end - now() > 366 * 86400000) fail('program_booking_date_invalid', 'Reserva citas futuras, dentro del próximo año.');
        return { ...session, choice: row, start_at: start.toISOString(), end_at: end.toISOString() };
      }).sort((a, b) => a.position - b.position);
      const reserved = plan.sessions.filter(row => row.scheduling_status === 'reserved').length;
      if (selected.length + reserved > Number(plan.voucher.available_units)) fail('program_units_insufficient', 'No quedan suficientes sesiones sin reservar.');
      const issues = seriesIssues(plan.sessions.map(row => selected.find(item => item.key === row.key) || row), plan.snapshot.cadence, plan.timeZone);
      if (issues.length) fail('program_cadence_conflict', 'Las fechas no respetan la pauta del programa.', { issues });
      // Validate scope for EVERY treatment in the immutable purchase, not just
      // the legacy primary-treatment projection used by older screens.
      for (const treatmentId of new Set(selected.flatMap(row => row.treatment_ids))) await loadScopedTreatment({ db, treatmentId, clinic: plan.clinic, transaction });
      const start = new Date(selected[0].start_at), end = new Date(selected.at(-1).end_at);
      const context = await contextFor(plan, selected, start, end, transaction, true);
      const created = [];
      for (const session of selected) {
        const solution = solveBookingProfile({ profile: session.booking_profile, ...context, start: new Date(session.start_at), selections: session.choice.selections });
        if (!solution || context.patientBusy.some(busy => new Date(busy.start) < new Date(session.end_at) && new Date(busy.end) > new Date(session.start_at))) fail('program_booking_unavailable', 'Un hueco acaba de ocuparse. No se ha reservado ninguna cita de esta solicitud.', { key: session.key });
        assertPriorityAcknowledgement(solution, session.choice.priority_acknowledged);
        const definition = plan.snapshot.appointments[session.position];
        const record = session.record || await db.PatientProgramSession.create({ voucher_id: plan.voucher.id, session_key: session.key,
          position: session.position, snapshot_sha256: plan.snapshot.sha256, snapshot: { ...definition, program_cadence: plan.snapshot.cadence } }, { transaction });
        const appointment = await mutateAppointmentBooking({ db, transaction, trustedProgramSession: record, preparedContext: context,
          capabilities: { simple: true, multi: true }, selections: session.choice.selections,
          priorityAcknowledged: session.choice.priority_acknowledged,
          appointmentValues: { clinica_id: plan.voucher.clinic_id, paciente_id: plan.voucher.patient_id, voucher_id: plan.voucher.id,
            tratamiento_id: session.treatment_ids[0], inicio: session.start_at, fin: session.end_at, estado: 'pendiente', tipo_cita: 'continuacion',
            titulo: `${plan.snapshot.name} · ${session.label}`.slice(0, 255), created_by: options.actorId, updated_by: options.actorId,
            source_system: 'treatment_program', source_reference: `program-session:${record.id}:${request.request_key}`.slice(0, 120),
            import_metadata: { automation_policy: 'hold', notification_suppression: { appointment_details: true, day_before: true, same_day: true } } },
          persist: ({ values }) => db.CitaPaciente.create(values, { transaction }) });
        await record.update({ appointment_id: appointment.id_cita }, { transaction });
        addVirtualBusy(context, solution);
        created.push({ key: session.key, appointment_id: appointment.id_cita, start_at: solution.start_at, end_at: solution.end_at, phases: solution.phases });
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
