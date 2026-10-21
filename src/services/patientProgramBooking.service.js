'use strict';

const { domainError } = require('../lib/treatmentPrograms.contract');
const { programBookingEnabled, bookingRequest, seriesIssues, schedulingMode, materializeSession, durationChoice } = require('../lib/program-booking');
const { operationalSnapshot } = require('../lib/economicProgramSnapshot');
const { resolveClinicTimezone, formatDateLocal } = require('../lib/availability-calendar');
const { resolveLocalInstant } = require('../lib/voucher-schedule-calendar');
const { addDays } = require('../lib/personal-schedule-recurring');
const { loadBookingContext, resolveInstallationKeys, solutionsForCalendar } = require('./appointmentBookingAvailability.service');
const { lockBookingResources, mutateAppointmentBooking } = require('./appointmentBookingCommand.service');
const { solveBookingProfile, occupancyForSolution } = require('../lib/booking-profile-solver');
const { assertPriorityAcknowledgement, loadScopedTreatment, bookingCapabilities, assertOperationalBookingProfile } = require('./treatmentBookingProfile.service');
const { equipmentIds } = require('../lib/booking-equipment');
const { schedulingState, planRevision, resumeInfo, resumeSelectionInfo, resumeOptions, resumeSessions, resumeInput, assertRevision, createSeriesContext } = require('../lib/program-replan');
const { additionalStaffSnapshot } = require('../lib/appointment-additional-staff');
const { installationAllowsStaff } = require('../lib/installation-professionals');
const { isFree } = require('../lib/booking-profile-solver');
const { attentionVisitOrigin } = require('../lib/booking-attention-origin');
const { cloneProgramContext, programScheduleContext, programScheduleAssessment, programScheduleBatchReceipt,
  programScheduleReceiptMatches } = require('../lib/program-schedule-confirmation');
const { rescheduleInput, rescheduleSessions, shiftedChoices, assertCivilShift, rescheduleDto } = require('../lib/program-reschedule');
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = (code, message, details, status = 409) => { throw domainError(status, code, message, details); };

function addVirtualBusy(context, solution, staff = [], profile = null) {
  const virtualId = profile?.version === 4 ? (context.attention_virtual_id || 0) - 1 : null;
  if (virtualId != null) context.attention_virtual_id = virtualId;
  const occupancy = occupancyForSolution(solution, context.installationKeys).map(row => ({ ...row,
    ...(virtualId != null ? { appointment_id: virtualId } : {}) }));
  for (const row of occupancy) {
    const targets = row.resource_kind === 'equipment' ? [context.equipment?.get(Number(row.resource_key.split(':')[1]))]
      : row.doctor_id ? [context.doctors.get(row.doctor_id)]
      : [...context.installations].filter(([id]) => context.installationKeys.get(id) === row.resource_key).map(([, target]) => target);
    for (const target of new Set(targets)) if (target) target.busy.push({ start: row.start_at, end: row.end_at,
      ...(virtualId != null ? { appointment_id: virtualId, protected_attention_origin: true } : {}) });
  }
  if (virtualId != null) {
    const frozen = { ...profile, phases: profile.phases.map((phase, index) => ({ ...phase,
      ...(solution.phases[index].staff_attention ? { staff_attention: solution.phases[index].staff_attention } : {}) })) };
    for (const doctorId of new Set(occupancy.map(row => row.doctor_id).filter(Boolean))) {
      const target = context.doctors.get(doctorId);
      const appointment = { id_cita: virtualId, clinica_id: target?.clinic_id, inicio: solution.start_at, fin: solution.end_at,
        booking_attention_snapshot: { version: 1, profile: frozen, phases: solution.phases,
          capacity_fully_verified: solution.capacity_fully_verified, attention_requirements_pending: solution.attention_requirements_pending } };
      if (target) (target.attention_visits ||= []).push({ ...attentionVisitOrigin({ appointment, doctorId, occupancies: occupancy }),
        protected_attention_origin: true });
    }
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

function createPatientProgramBookingService({ db, enabled = programBookingEnabled, capabilities = bookingCapabilities, now = () => new Date() }) {
  function assertEnabled() { if (!enabled()) fail('program_booking_disabled', 'La reserva de programas aún no está habilitada en este entorno.', null, 503); }
  function assertRelativeSessions(sessions) {
    for (const session of sessions) if (session.booking_profile.version === 4) {
      assertOperationalBookingProfile(session.booking_profile, { capabilities: capabilities() });
    }
  }
  async function load({ publicId, clinicId, transaction = null, lock = false }) {
    assertEnabled();
    if (!Number.isSafeInteger(clinicId) || clinicId < 1) fail('program_clinic_required', 'Clínica no válida.', null, 400);
    const voucher = await db.PatientVoucher.findOne({ where: { public_id: publicId, clinic_id: clinicId, source_system: 'treatment_program' },
      transaction, ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) });
    if (!voucher) fail('program_purchase_not_found', 'Programa comprado no encontrado.', null, 404);
    const [clinic, records] = await Promise.all([
      db.Clinica.findByPk(clinicId, { transaction, ...(lock ? { lock: transaction.LOCK.SHARE } : {}) }),
      db.PatientProgramSession.findAll({ where: { voucher_id: voucher.id }, order: [['position', 'ASC']], transaction,
        ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) }),
    ]);
    if (!clinic) fail('program_purchase_invalid', 'No se encuentra la clínica de este programa.');
    let budget = null, operationallyAuthorized = false, snapshot, origin = 'budget';
    if (voucher.budget_id != null) {
      // Budget purchases NEVER fall back to clinical enrollment evidence. A
      // pending/missing budget cannot be made accepted by supplying this JSON.
      if (voucher.program_snapshot != null) fail('program_enrollment_origin_conflict', 'La compra y la asignación clínica no pueden sustituirse entre sí.');
      budget = await db.EconomicBudget.findOne({ where: { id: voucher.budget_id, clinic_id: clinicId, patient_id: voucher.patient_id }, transaction });
      if (!budget) fail('program_purchase_invalid', 'No se encuentra el presupuesto de este programa.');
      const version = await db.EconomicBudgetVersion.findOne({ where: { budget_id: budget.id, version_number: budget.current_version }, transaction });
      const line = json(version?.lines || []).find(item => item.key === voucher.budget_line_key);
      operationallyAuthorized = budget.status === 'accepted';
      if (budget.status === 'partially_accepted') {
        const event = await db.EconomicBudgetEvent.findOne({ where: { budget_id: budget.id, version_number: budget.current_version, event_type: 'partially_accepted' }, order: [['id', 'DESC']], transaction });
        operationallyAuthorized = (json(event?.metadata || {})?.accepted_line_keys || []).includes(voucher.budget_line_key);
      }
      snapshot = operationalSnapshot(line?.program_snapshot);
    } else {
      snapshot = require('../lib/patient-program-enrollment').readProgramEnrollment(voucher, { required: true });
      operationallyAuthorized = true; origin = 'program_enrollment';
    }
    if (Number(voucher.total_units) !== snapshot.appointments.length || records.some(row => row.snapshot_sha256 !== snapshot.sha256)) fail('program_purchase_changed', 'La composición comprada no coincide con sus sesiones. Revisa el presupuesto.');
    const ids = records.map(row => row.appointment_id).filter(Boolean);
    const appointments = ids.length ? await db.CitaPaciente.findAll({ where: { id_cita: { [db.Sequelize.Op.in]: ids },
      voucher_id: voucher.id, paciente_id: voucher.patient_id, clinica_id: clinicId }, transaction,
      ...(lock ? { lock: transaction.LOCK.UPDATE } : {}) }) : [];
    const sessions = snapshot.appointments.map((definition, position) => {
      const record = records.find(row => row.session_key === definition.key);
      const appointment = appointments.find(row => Number(row.id_cita) === Number(record?.appointment_id));
      if (record?.appointment_id && !appointment) fail('program_session_inconsistent', 'Falta una cita del historial del programa.');
      const unrecorded = origin === 'program_enrollment' && position < (snapshot.enrollment?.start_from_position || 1) - 1;
      if (unrecorded && record) fail('program_session_inconsistent', 'Una sesión anterior al registro no puede tener una cita o consumo asociado.');
      const status = unrecorded ? 'unrecorded' : schedulingState(record, appointment);
      const scheduled = appointment && ['reserved', 'completed'].includes(status);
      const bookedSnapshot = json(record?.snapshot || {});
      const durationSnapshot = definition.duration_minutes == null && bookedSnapshot.duration_selection
        ? materializeSession(definition, bookedSnapshot.duration_selection) : definition;
      return { ...durationSnapshot, position, record, appointment, scheduling_status: status,
        start_at: scheduled ? new Date(appointment.inicio).toISOString() : null,
        end_at: scheduled ? new Date(appointment.fin).toISOString() : null };
    });
    // Names are scoped catalog metadata, never a declaration of availability.
    // A clinician with no open hours must still be selectable explicitly, but
    // inactive/out-of-clinic resources cannot be added by a client selector.
    const roomIds = [...new Set(sessions.flatMap(row => row.booking_profile.phases.flatMap(phase => phase.installation_ids)))];
    const doctorIds = [...new Set(sessions.flatMap(row => row.booking_profile.phases.flatMap(phase => phase.professionals.ids)))];
    const [rooms, doctors] = await Promise.all([
      roomIds.length && db.Instalacion ? db.Instalacion.findAll({ where: { clinica_id: clinicId, activo: true,
        id: { [db.Sequelize.Op.in]: roomIds } }, attributes: ['id', 'nombre'], transaction }) : [],
      doctorIds.length && db.DoctorClinica ? db.DoctorClinica.findAll({ where: { clinica_id: clinicId, activo: true,
        recibe_citas: true, doctor_id: { [db.Sequelize.Op.in]: doctorIds } }, attributes: ['doctor_id'], transaction,
        ...(db.Usuario ? { include: [{ model: db.Usuario, as: 'doctor', attributes: ['id_usuario', 'nombre', 'apellidos'] }] } : {}) }) : [],
    ]);
    const resourceOptions = { installations: rooms.filter(row => roomIds.includes(Number(row.id))).map(row => ({ id: Number(row.id), name: row.nombre || `Instalación ${row.id}` })),
      professionals: doctors.filter(row => doctorIds.includes(Number(row.doctor_id))).map(row => ({ id: Number(row.doctor_id),
        name: [row.doctor?.nombre, row.doctor?.apellidos].filter(Boolean).join(' ') || `Profesional ${row.doctor_id}` })) };
    return { voucher, budget, operationallyAuthorized, origin, clinic, snapshot, sessions, resourceOptions, timeZone: resolveClinicTimezone(clinic) };
  }
  function assertSchedulable(plan) {
    if (!plan.operationallyAuthorized || plan.voucher.status !== 'active'
      || (plan.voucher.expires_at && new Date(plan.voucher.expires_at) <= now())) fail('program_purchase_not_schedulable', plan.origin === 'program_enrollment'
        ? 'La asignación clínica debe estar activa y sin caducar.' : 'El programa debe estar aceptado, activo y sin caducar.');
    // Partial acceptance activates only accepted lines in the canonical voucher
    // writer. No client checkbox or payment inference can activate this unit.
    const reserved = plan.sessions.filter(row => row.scheduling_status === 'reserved').length;
    if (Number(plan.voucher.available_units) < reserved) fail('program_units_inconsistent', 'Revisa las sesiones disponibles de este programa.');
  }
  function dto(plan, { resumeFromKey = null } = {}) {
    const pending = plan.sessions.filter(row => ['pending', 'missed'].includes(row.scheduling_status)).length;
    const mode = schedulingMode(plan.snapshot);
    const legacyResume = mode === 'manual' ? null : resumeInfo(plan, now());
    const resume = resumeFromKey == null ? legacyResume : resumeSelectionInfo(plan, resumeFromKey, now());
    const resumeChoices = resumeOptions(plan, now());
    const active = plan.voucher.status === 'active' && plan.operationallyAuthorized && (!plan.voucher.expires_at || new Date(plan.voucher.expires_at) > now());
    // Purchased history stays readable while the relative-step writer is off.
    // This marker cannot turn an incomplete attention plan into a bookable one.
    let bookingRestriction = null;
    try { assertRelativeSessions(plan.sessions.filter(row => row.scheduling_status !== 'unrecorded')); } catch (error) {
      if (!['booking_profile_runtime_unavailable', 'pending_attention_requirements', 'booking_profile_attention_ambiguous'].includes(error.code)) throw error;
      bookingRestriction = { code: error.code, message: error.message };
    }
    return { voucher_id: plan.voucher.public_id, clinic_id: Number(plan.voucher.clinic_id), name: plan.snapshot.name, kind: plan.snapshot.kind,
      program_id: plan.snapshot.program_id, program_version: plan.snapshot.program_version, origin: plan.origin,
      commercial_status: plan.origin === 'program_enrollment' ? 'not_contracted' : plan.operationallyAuthorized ? 'budget_accepted' : 'budget_pending',
      catalog_reference_amount: plan.snapshot.catalog_total_price,
      ...(plan.origin === 'program_enrollment' && plan.snapshot.enrollment?.start_from_position > 1
        ? require('../lib/patient-program-enrollment').enrollmentProgress(plan.voucher, plan.snapshot) : {}),
      snapshot_sha256: plan.snapshot.sha256, timezone: plan.timeZone, cadence: plan.snapshot.cadence,
      resource_options: plan.resourceOptions,
      plan_revision: planRevision(plan), scheduling_mode: mode,
      automatic_scheduling_available: !bookingRestriction && mode !== 'manual' && plan.sessions.filter(row => row.scheduling_status !== 'unrecorded').every(session => session.duration_minutes != null),
      resume, resume_options: resumeChoices, can_resume: !bookingRestriction && resumeChoices.some(option => !option.blocked_reason) && active,
      pending_count: pending, can_schedule: !bookingRestriction && pending > 0 && active && !legacyResume,
      ...(bookingRestriction ? { booking_restriction: bookingRestriction } : {}),
      sessions: plan.sessions.map(({ record, appointment, ...row }) => ({ ...row,
        requires_manual_date: mode === 'manual', duration_required: row.duration_minutes == null,
        appointment_id: appointment?.id_cita || null,
        previous_appointment: previousAppointment({ appointment }),
        phases: json(appointment?.import_metadata || {})?.booking?.phases || [] })) };
  }
  async function contextFor(plan, sessions, start, end, transaction = null, lock = false, ignoreAppointmentIds = []) {
    assertRelativeSessions(sessions);
    // Include support calendars in the single bulk read without making a person
    // assisting one session a mandatory participant of every other session.
    const profile = { version: 1, phases: sessions.flatMap(row => row.booking_profile.phases.map(phase => ({ ...phase,
      professionals: { ...phase.professionals, ids: [...new Set([...phase.professionals.ids, ...supportIds(row)])] } }))) };
    const installationIds = [...new Set(profile.phases.flatMap(row => row.installation_ids))];
    const doctorIds = [...new Set(profile.phases.flatMap(row => row.professionals.ids))];
    const machineIds = equipmentIds(profile);
    profile.version = sessions.some(session => session.booking_profile.version === 4) ? 4
      : profile.phases.some(phase => phase.staff_attention) ? 3 : machineIds.length ? 2 : 1;
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
      installationMapping: mapping, patientId: plan.voucher.patient_id, ignoreAppointmentIds, includeDiagnosticLabels: true });
  }
  async function read(options) { return dto(await load(options)); }

  function fixedSessions(plan, pending, selectedKeys, payload) {
    const fixed = payload.fixed_sessions || [];
    if (!Array.isArray(fixed) || fixed.length > 30 || new Set(fixed.map(row => row?.key)).size !== fixed.length) fail('program_search_invalid', 'Revisa las fechas conservadas.', null, 400);
    if (!fixed.length) return [];
    const choices = fixed.map(row => {
      if (!row || !pending.some(item => item.key === row.key) || selectedKeys.includes(row.key)) {
        fail('program_search_invalid', 'No se puede conservar y cambiar la misma sesión, ni cambiar una sesión ajena al tramo elegido.', null, 400);
      }
      const instant = new Date(row.start_at);
      if (!Number.isFinite(instant.getTime()) || instant <= now() || instant - now() > 366 * 86400000) fail('program_search_invalid', 'Fecha conservada no válida.', null, 400);
      return { ...row, start_at: instant.toISOString() };
    });
    // Same selection/duration parser as confirmation; resource/phase identity
    // is still checked against the server-owned purchased session below.
    const normalized = bookingRequest({ request_key: 'program-fixed-preview', snapshot_sha256: plan.snapshot.sha256, sessions: choices }).sessions;
    return normalized.map(choice => {
      const session = materializeSession(pending.find(row => row.key === choice.key), choice);
      if (Object.keys(choice.selections).some(key => !session.booking_profile.phases.some(phase => phase.key === key))) fail('program_selection_invalid', 'La fase elegida no pertenece a esta cita.');
      return { ...session, choice, start_at: choice.start_at,
        end_at: new Date(new Date(choice.start_at).getTime() + session.duration_minutes * 60000).toISOString() };
    }).sort((a, b) => a.position - b.position);
  }
  function proposalSeries(plan, pending, resume, replacements) {
    // A date belonging to an old affected reservation is history, not a new
    // manual choice. Unaffected prefix/completed rows stay fixed constraints.
    return plan.sessions.map(row => replacements.find(item => item.key === row.key)
      || (resume && pending.some(item => item.key === row.key) ? { ...row, start_at: null, end_at: null } : row));
  }
  function scheduleAssessment(plan, session, context, actorId) {
    return programScheduleAssessment({ profile: session.booking_profile, context,
      start: session.start_at, end: session.end_at, selections: session.choice.selections,
      additionalStaffIds: supportIds(session), actorId, clinicId: Number(plan.voucher.clinic_id),
      clinicName: plan.clinic.nombre_clinica || '', treatmentId: session.treatment_ids[0], treatmentName: session.label,
      patientId: Number(plan.voucher.patient_id), appointmentId: session.appointment?.id_cita || null,
      previous: session.appointment?.toJSON ? session.appointment.toJSON() : session.appointment || null });
  }
  function checkFixedSessions(context, sessions, plan, actorId) {
    for (const session of sessions) {
      const staff = supportIds(session);
      const solution = solveBookingProfile({ profile: session.booking_profile, ...context,
        start: new Date(session.start_at), selections: session.choice.selections })
        || scheduleAssessment(plan, session, context, actorId)?.solution;
      if (!solution || new Date(solution.end_at).getTime() !== new Date(session.end_at).getTime() || !supportAvailable(context, solution, staff)
        || context.patientBusy.some(busy => new Date(busy.start) < new Date(session.end_at) && new Date(busy.end) > new Date(session.start_at))) {
        fail('program_fixed_session_unavailable', 'Una fecha conservada ya no está disponible. Revisa esa sesión antes de continuar.', { key: session.key });
      }
      addVirtualBusy(context, solution, staff, session.booking_profile);
    }
  }

  async function propose(options) {
    const plan = await load(options); assertSchedulable(plan);
    const payload = options.payload || {};
    if (payload.draft_strategy != null) {
      if (schedulingMode(plan.snapshot) !== 'manual' && resumeInfo(plan, now())) fail('program_resume_required', 'Retoma el programa para revisar juntas las sesiones pendientes y sus fechas.');
      assertRelativeSessions(plan.sessions.filter(row=>row.scheduling_status==='pending'));
      return require('./patientProgramDraftPreview.service').preview({ plan, payload,
        actorId: options.actorId, now: now(), contextFor, dto, solve: solveBookingProfile, slots: solutionsForCalendar,
        addVirtualBusy, supportIds, supportAvailable, assessment: scheduleAssessment });
    }
    const reschedule = rescheduleInput(payload);
    if (reschedule) {
      const { normalizePreferences, allowedInterval, timeWarning } = require('../lib/program-booking-preferences');
      const preferences = normalizePreferences(payload.booking_preferences);
      assertRevision(plan, reschedule.expected_plan_revision);
      const selected = rescheduleSessions(plan, reschedule, now()); assertRelativeSessions(selected);
      if (payload.fixed_sessions?.length || payload.session_keys != null && (!Array.isArray(payload.session_keys)
        || payload.session_keys.length !== selected.length || selected.some(row => !payload.session_keys.includes(row.key)))) {
        fail('program_reschedule_incomplete', 'Mueve sólo las reservas futuras del tramo elegido; las sesiones sin fecha se conservan pendientes.');
      }
      const choices = shiftedChoices(plan, selected, reschedule, payload.reschedule_start_local, payload.manual_sessions || []);
      const normalized = bookingRequest({ request_key: 'program-reschedule-preview', snapshot_sha256: plan.snapshot.sha256, sessions: choices }).sessions;
      const explicit = selected.map(session => {
        const choice = normalized.find(row => row.key === session.key), start = new Date(choice.start_at);
        if (start <= now() || start - now() > 366 * 86400000) fail('program_booking_date_invalid', 'Reserva citas futuras, dentro del próximo año.');
        if (Object.keys(choice.selections).some(key => !session.booking_profile.phases.some(phase => phase.key === key))) fail('program_selection_invalid', 'La fase elegida no pertenece a esta cita.');
        return { ...session, choice, start_at: start.toISOString(), end_at: new Date(start.getTime() + session.duration_minutes * 60000).toISOString() };
      });
      const series = plan.sessions.map(row => explicit.find(item => item.key === row.key) || row);
      const orderIssues = seriesIssues(series, plan.snapshot.cadence, plan.timeZone);
      const context = await contextFor(plan, explicit, new Date(Math.min(...explicit.map(row => new Date(row.start_at).getTime()))),
        new Date(Math.max(...explicit.map(row => new Date(row.end_at).getTime()))), null, false, selected.map(row => Number(row.appointment.id_cita)));
      const proposals = explicit.map(session => {
        const excluded = !allowedInterval(preferences, session.start_at, session.end_at, plan.timeZone);
        let solution = orderIssues.length || excluded ? null : solveBookingProfile({ profile: session.booking_profile, ...context, start: new Date(session.start_at), selections: session.choice.selections });
        const exception = !orderIssues.length && !excluded && !solution ? scheduleAssessment(plan, session, context, options.actorId) : null;
        if (exception) solution = exception.solution;
        const available = solution && supportAvailable(context, solution, supportIds(session))
          && !context.patientBusy.some(busy => new Date(busy.start) < new Date(session.end_at) && new Date(busy.end) > new Date(session.start_at));
        if (available) addVirtualBusy(context, solution, supportIds(session), session.booking_profile);
        const warnings = available ? timeWarning(preferences, solution, plan.timeZone) : [];
        return { key: session.key, label: session.label, solution: available ? solution : null, previous_appointment: previousAppointment(session),
          requested_start_at: session.start_at, requested_start_local: choices.find(row => row.key === session.key).start_local,
          selections: session.choice.selections, priority_acknowledged: session.choice.priority_acknowledged,
          reason_code: available ? null : orderIssues.length ? 'program_cadence_conflict' : excluded ? 'program_booking_preference_conflict' : 'program_booking_unavailable',
          reason: available ? null : orderIssues.length ? 'Las fechas no respetan el orden o la pauta del programa.' : excluded
            ? 'La fecha coincide con un día excluido por el paciente.' : 'Este horario no está disponible. Elige otro inicio; no se desplazarán fechas automáticamente.',
          ...(warnings.length ? { preference_warnings: warnings } : {}),
          ...(available && exception ? { requires_schedule_confirmation: true, schedule_restrictions: exception.restrictions } : {}) };
      });
      return { ...dto(plan), proposals, unproposed_count: 0, reschedule: rescheduleDto(reschedule, selected, payload.reschedule_start_local),
        ...(preferences ? { booking_preferences: preferences } : {}) };
    }
    const resume = resumeInput(payload);
    if (resume) assertRevision(plan, resume.expected_plan_revision);
    else if (schedulingMode(plan.snapshot) !== 'manual' && resumeInfo(plan, now())) fail('program_resume_required', 'Retoma el programa para revisar juntas las sesiones pendientes y sus fechas.');
    const date = String(payload.from_date || '');
    const horizon = payload.days ?? 90;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(horizon) || horizon < 1 || horizon > 180) fail('program_search_invalid', 'Elige un día de inicio y un máximo de 180 días de búsqueda.', null, 400);
    const start = resolveLocalInstant(date, '00:00:00', plan.timeZone), endDate = addDays(date, horizon);
    if (formatDateLocal(start, plan.timeZone) !== date) fail('program_search_invalid', 'Fecha no válida.', null, 400);
    const end = resolveLocalInstant(endDate, '00:00:00', plan.timeZone);
    const manual = schedulingMode(plan.snapshot) === 'manual';
    const pending = resume ? resumeSessions(plan, resume.replan_from_key, now()) : plan.sessions.filter(row => row.scheduling_status === 'pending' || manual && row.scheduling_status === 'missed');
    const projectionOptions = { resumeFromKey: resume?.replan_from_key || null };
    if (!pending.length) return { ...dto(plan, projectionOptions), proposals: [], unproposed_count: 0 };
    const selectedKeys = payload.session_keys == null ? pending.slice(0, 30).map(row => row.key) : payload.session_keys;
    if (!Array.isArray(selectedKeys) || !selectedKeys.length || selectedKeys.length > 30 || new Set(selectedKeys).size !== selectedKeys.length
      || selectedKeys.some(key => !pending.some(row => row.key === key))) fail('program_search_invalid', 'Selecciona hasta treinta sesiones pendientes.', null, 400);
    let selected = pending.filter(row => selectedKeys.includes(row.key));
    // Even a date-less preview must not advertise an unavailable v4 writer or
    // a clinically incomplete attention plan as ready for scheduling.
    assertRelativeSessions(selected);
    const ignored = resume ? pending.filter(row => row.scheduling_status === 'reserved').map(row => Number(row.appointment.id_cita)) : [];
    const fixedRows = fixedSessions(plan, pending, selectedKeys, payload);
    if (payload.manual_sessions != null || manual || selected.some(session => session.duration_minutes == null)) {
      const choices = payload.manual_sessions || [];
      if (!Array.isArray(choices) || choices.length > 30 || new Set(choices.map(row => row?.key)).size !== choices.length
        || choices.some(row => !row || !selectedKeys.includes(row.key))) fail('program_search_invalid', 'Revisa las sesiones con fecha manual.', null, 400);
      const proposals = [];
      const explicit = [];
      for (const session of selected) {
        const choice = choices.find(row => row.key === session.key);
        if (!choice) {
          proposals.push({ key: session.key, label: session.label, solution: null, reason_code: 'program_manual_date_required',
            duration_required: session.duration_minutes == null,
            reason: 'Pendiente de citar. Elige expresamente la fecha y la hora de esta sesión.' });
          continue;
        }
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(choice.start_local || '')) fail('program_search_invalid', 'Elige una fecha y hora local válida.', null, 400);
        const instant = resolveLocalInstant(choice.start_local.slice(0, 10), `${choice.start_local.slice(11)}:00`, plan.timeZone);
        if (instant < start || instant >= end || instant <= now() || instant - now() > 366 * 86400000) fail('program_booking_date_invalid', 'Elige una cita futura dentro de los días consultados y del próximo año.', null, 400);
        const resolved = materializeSession(session, durationChoice(choice));
        const finish = new Date(instant.getTime() + resolved.duration_minutes * 60000);
        const normalizedChoice = bookingRequest({ request_key: 'program-manual-preview', snapshot_sha256: plan.snapshot.sha256,
          sessions: [{ ...choice, start_at: instant.toISOString() }] }).sessions[0];
        if (Object.keys(normalizedChoice.selections).some(key => !resolved.booking_profile.phases.some(phase => phase.key === key))) fail('program_selection_invalid', 'La fase elegida no pertenece a esta cita.');
        explicit.push({ ...resolved, choice: normalizedChoice, start_at: instant.toISOString(), end_at: finish.toISOString() });
      }
      if (explicit.length || fixedRows.length) {
        const searchStart = new Date(Math.min(start.getTime(), ...fixedRows.map(row => new Date(row.start_at).getTime())));
        const searchEnd = new Date(Math.max(end.getTime(), ...fixedRows.map(row => new Date(row.end_at).getTime())));
        const context = await contextFor(plan, [...fixedRows, ...explicit], searchStart, searchEnd, null, false, ignored);
        const series = proposalSeries(plan, pending, resume, [...explicit, ...fixedRows]);
        const orderIssues = seriesIssues(series, plan.snapshot.cadence, plan.timeZone);
        checkFixedSessions(context, fixedRows, plan, options.actorId);
        for (const session of explicit) {
          const staff = supportIds(session);
          let solution = orderIssues.length ? null : solveBookingProfile({ profile: session.booking_profile, ...context,
            start: new Date(session.start_at), selections: session.choice.selections || {} });
          const exception = !orderIssues.length && !solution ? scheduleAssessment(plan, session, context, options.actorId) : null;
          if (exception) solution = exception.solution;
          const available = solution && supportAvailable(context, solution, staff)
            && !context.patientBusy.some(busy => new Date(busy.start) < new Date(session.end_at) && new Date(busy.end) > new Date(session.start_at));
          if (available) addVirtualBusy(context, solution, staff, session.booking_profile);
          proposals.push({ key: session.key, label: session.label, solution: available ? solution : null,
            ...(session.duration_selection || {}), previous_appointment: previousAppointment(session),
            reason_code: available ? null : orderIssues.length ? 'program_cadence_conflict' : 'program_booking_unavailable',
            reason: available ? null : orderIssues.length ? 'La fecha elegida no respeta el orden o la pauta del programa.' : 'No hay disponibilidad en la fecha y hora elegidas.',
            ...(available && exception ? { requires_schedule_confirmation: true, schedule_restrictions: exception.restrictions } : {}) });
        }
      }
      return { ...dto(plan, projectionOptions), proposals: selected.map(session => proposals.find(row => row.key === session.key)),
        unproposed_count: pending.length - selected.length };
    }
    const searchStart = new Date(Math.min(start.getTime(), ...fixedRows.map(row => new Date(row.start_at).getTime())));
    const searchEnd = new Date(Math.max(end.getTime(), ...fixedRows.map(row => new Date(row.end_at).getTime())));
    const context = await contextFor(plan, [...(resume ? pending : selected), ...fixedRows], searchStart, searchEnd, null, false, ignored);
    const series = proposalSeries(plan, pending, resume, fixedRows).map(row => ({ key: row.key, offset_days: row.offset_days, start_at: row.start_at, end_at: row.end_at }));
    const proposals = [];
    // Optional fixed proposals are rechecked, never trusted as reservations. This
    // lets the dialog ask for another day for one unit while retaining the rest.
    checkFixedSessions(context, fixedRows, plan, options.actorId);
    const first = series.find(row => row.start_at);
    const anchor = first ? formatDateLocal(new Date(first.start_at), plan.timeZone) : date;
    const anchorOffset = first?.offset_days ?? selected[0]?.offset_days ?? 0;
    for (const session of selected) {
      const staff = supportIds(session);
      const sessionContext = staff.length ? { ...context, installations: new Map([...context.installations].map(([id, room]) => [id,
        installationAllowsStaff(room, staff) ? room : { ...room, windows: [] }])) } : context;
      let chosen = null;
      let earliest = date;
      if (!plan.snapshot.cadence && session.offset_days != null) earliest = [date, addDays(anchor, session.offset_days - anchorOffset)].sort().at(-1);
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
        addVirtualBusy(context, chosen, staff, session.booking_profile);
        Object.assign(series[session.position], { start_at: chosen.start_at, end_at: chosen.end_at });
      }
      proposals.push({ key: session.key, label: session.label, solution: chosen,
        previous_appointment: previousAppointment(session),
        reason: chosen ? null : 'No hay un hueco que respete la pauta en los días consultados.' });
    }
    return { ...dto(plan, projectionOptions), proposals, unproposed_count: pending.length - selected.length };
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
      const reschedule = request.mode === 'reschedule';
      const resume = request.mode === 'resume';
      if (resume || reschedule) assertRevision(plan, request.expected_plan_revision);
      else if (schedulingMode(plan.snapshot) !== 'manual' && resumeInfo(plan, now())) fail('program_resume_required', 'Retoma el programa para revisar juntas las sesiones pendientes y sus fechas.');
      const eligible = reschedule ? rescheduleSessions(plan, request, now()) : resume ? resumeSessions(plan, request.replan_from_key, now()) : plan.sessions.filter(row => row.scheduling_status === 'pending'
        || schedulingMode(plan.snapshot) === 'manual' && row.scheduling_status === 'missed');
      if (reschedule) assertCivilShift(plan, eligible, request);
      if (resume && (request.sessions.length !== eligible.length || eligible.some(row => !request.sessions.some(item => item.key === row.key)))) fail('program_resume_incomplete', 'Confirma todas las sesiones de la propuesta para conservar el orden y la pauta.');
      const selected = request.sessions.map(row => {
        const pendingSession = eligible.find(item => item.key === row.key);
        if (!pendingSession) fail('program_session_not_pending', 'Una sesión elegida ya está reservada o completada. Actualiza el plan.');
        const session = materializeSession(pendingSession, row);
        if (Object.keys(row.selections).some(key => !session.booking_profile.phases.some(phase => phase.key === key))) fail('program_selection_invalid', 'La fase elegida no pertenece a esta cita.');
        const start = new Date(row.start_at), end = new Date(start.getTime() + session.duration_minutes * 60000);
        if (start <= now() || end - now() > 366 * 86400000) fail('program_booking_date_invalid', 'Reserva citas futuras, dentro del próximo año.');
        return { ...session, choice: row, start_at: start.toISOString(), end_at: end.toISOString() };
      }).sort((a, b) => a.position - b.position);
      require('../lib/program-booking-preferences').assertAllowed(request.booking_preferences, selected, plan.timeZone);
      const reserved = plan.sessions.filter(row => row.scheduling_status === 'reserved' && !selected.some(item => item.key === row.key)).length;
      if (selected.length + reserved > Number(plan.voucher.available_units)) fail('program_units_insufficient', 'No quedan suficientes sesiones sin reservar.');
      const series = plan.sessions.map(row => selected.find(item => item.key === row.key) || row).map(row => ({ key: row.key, offset_days: row.offset_days, start_at: row.start_at, end_at: row.end_at }));
      const issues = seriesIssues(series, plan.snapshot.cadence, plan.timeZone);
      if (issues.length) fail('program_cadence_conflict', 'Las fechas no respetan la pauta del programa.', { issues });
      // Validate scope for EVERY treatment in the immutable purchase, not just
      // the legacy primary-treatment projection used by older screens.
      for (const treatmentId of new Set(selected.flatMap(row => row.treatment_ids))) await loadScopedTreatment({ db, treatmentId, clinic: plan.clinic, transaction });
      const start = new Date(selected[0].start_at), end = new Date(selected.at(-1).end_at);
      const ignored = selected.filter(row => row.scheduling_status === 'reserved').map(row => Number(row.appointment.id_cita));
      const context = await contextFor(plan, selected, start, end, transaction, true, ignored);
      // Preflight the WHOLE batch under the same canonical resource locks.
      // A closed clinician schedule can only be accepted for exact selected
      // staff/rooms; other conflicts abort without creating even session rows.
      const checkingContext = cloneProgramContext(context), exceptions = new Map();
      for (const session of selected) {
        const staff = supportIds(session);
        let solution = solveBookingProfile({ profile: session.booking_profile, ...checkingContext,
          start: new Date(session.start_at), selections: session.choice.selections });
        const exception = !solution ? scheduleAssessment(plan, session, checkingContext, options.actorId) : null;
        if (exception) { solution = exception.solution; exceptions.set(session.key, exception); }
        if (!solution || !supportAvailable(checkingContext, solution, staff)
          || checkingContext.patientBusy.some(busy => new Date(busy.start) < new Date(session.end_at) && new Date(busy.end) > new Date(session.start_at))) {
          fail('program_booking_unavailable', 'Un hueco acaba de ocuparse o tiene restricciones que no se pueden confirmar. No se ha reservado ni movido ninguna cita de esta solicitud.', { key: session.key });
        }
        assertPriorityAcknowledgement(solution, session.choice.priority_acknowledged);
        addVirtualBusy(checkingContext, solution, staff, session.booking_profile);
      }
      const scheduleExceptions = new Map();
      if (exceptions.size) {
        const acknowledgement = programScheduleBatchReceipt({ plan, request, actorId: options.actorId, exceptions });
        if (!programScheduleReceiptMatches(acknowledgement, request.schedule_acknowledgement)) fail('program_schedule_confirmation_required',
          'Hay profesionales sin horario de atención en las fechas elegidas. Revisa todos los avisos y confirma si quieres reservar igualmente.',
          { can_confirm_schedule: true, schedule_acknowledgement: acknowledgement,
            batch_restrictions: selected.filter(row => exceptions.has(row.key)).map(row => ({ key: row.key, label: row.label,
              restrictions: exceptions.get(row.key).restrictions })) });
        for (const [key, exception] of exceptions) scheduleExceptions.set(key, { doctorIds: exception.doctorIds,
          restrictions: exception.restrictions, acknowledgement, actorId: Number(options.actorId) });
      }
      for (const session of selected) {
        const definition = plan.snapshot.appointments[session.position];
        const sessionSnapshot = { ...definition, booking_profile: session.booking_profile, duration_minutes: session.duration_minutes,
          ...(session.duration_selection ? { duration_selection: session.duration_selection } : {}), program_cadence: plan.snapshot.cadence };
        session.record ||= await db.PatientProgramSession.create({ voucher_id: plan.voucher.id, session_key: session.key,
          position: session.position, snapshot_sha256: plan.snapshot.sha256, snapshot: sessionSnapshot }, { transaction });
        if (definition.duration_minutes == null && !json(session.record.snapshot).duration_selection) await session.record.update({ snapshot: sessionSnapshot }, { transaction });
      }
      const trustedProgramSeries = createSeriesContext({ transaction, plan, selected, series, scheduleExceptions });
      const created = [];
      for (const session of selected) {
        const staff = supportIds(session);
        const exception = scheduleExceptions.get(session.key);
        const solvingContext = exception ? programScheduleContext(context, exception.doctorIds,
          new Date(session.start_at), new Date(session.end_at)) : context;
        const solution = solveBookingProfile({ profile: session.booking_profile, ...solvingContext, start: new Date(session.start_at), selections: session.choice.selections });
        if (!solution || !supportAvailable(context, solution, staff) || context.patientBusy.some(busy => new Date(busy.start) < new Date(session.end_at) && new Date(busy.end) > new Date(session.start_at))) fail('program_booking_unavailable', 'Un hueco acaba de ocuparse. No se ha reservado ni movido ninguna cita de esta solicitud.', { key: session.key });
        assertPriorityAcknowledgement(solution, session.choice.priority_acknowledged);
        const record = session.record;
        const moving = session.scheduling_status === 'reserved';
        const previous = previousAppointment(session);
        const appointment = await mutateAppointmentBooking({ db, transaction, trustedProgramSeries, preparedContext: context,
          ...(moving ? { existingAppointmentId: session.appointment.id_cita } : { trustedProgramSession: record }),
          additionalStaffIds: staff,
          capabilities: capabilities(), selections: session.choice.selections,
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
        addVirtualBusy(context, solution, staff, session.booking_profile);
        created.push({ key: session.key, appointment_id: appointment.id_cita, action: moving ? 'rescheduled' : 'created', previous_appointment: previous,
          start_at: solution.start_at, end_at: solution.end_at, phases: solution.phases });
      }
      const result = { voucher_id: plan.voucher.public_id, sessions: created, reminders_enabled: false, replayed: false,
        ...(request.booking_preferences ? { booking_preferences: request.booking_preferences } : {}),
        ...(scheduleExceptions.size ? { schedule_exception_confirmed: true } : {}) };
      const receipt = await db.PatientProgramBookingRequest.create({ voucher_id: plan.voucher.id, request_key: request.request_key,
        request_sha256: request.request_sha256, result, created_by: options.actorId }, { transaction });
      const communication = await require('./patientProgramBookingNotice.service').recordBookingReceipt({ db, receipt,
        voucher: plan.voucher, snapshot: plan.snapshot, clinic: plan.clinic, actorId: options.actorId, transaction, now: now() });
      // A closed gate remains completely inert and keeps historical DTOs. The
      // active outbox projection is persisted in this same transaction so an
      // exact booking/reschedule replay returns it without another event/job.
      if (communication.reason !== 'runtime_disabled') {
        // Do not mutate the JSON object retained by Sequelize's initial
        // previousDataValues: that would look unchanged and skip the UPDATE.
        const completeResult = { ...result, communication };
        await receipt.update({ result: completeResult }, { transaction });
        return completeResult;
      }
      return result;
    });
  }
  async function linkAppointment(options) {
    assertEnabled();
    const { appointmentLinkRequest, compatibleLinkedAppointment } = require('../lib/program-appointment-link');
    const request = appointmentLinkRequest(options.payload);
    return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
      const plan = await load({ ...options, transaction, lock: true });
      const prior = await db.PatientProgramBookingRequest.findOne({ where: { voucher_id: plan.voucher.id, request_key: request.request_key }, transaction });
      if (prior) {
        if (prior.request_sha256 !== request.request_sha256) fail('program_booking_request_conflict', 'Esta referencia ya se utilizó con otra cita o sesión.');
        return { ...json(prior.result), replayed: true };
      }
      assertSchedulable(plan);
      if (request.snapshot_sha256 !== plan.snapshot.sha256) fail('program_snapshot_changed', 'Actualiza la composición comprada del programa.');
      assertRevision(plan, request.expected_plan_revision);
      const session = plan.sessions.find(row => row.key === request.session_key);
      if (!session || session.scheduling_status !== 'pending' || session.appointment || session.record?.consumption_movement_id) {
        fail('program_session_not_pending', 'Elige una sesión pendiente sin otra cita ni consumo registrado.');
      }
      const appointment = await db.CitaPaciente.findOne({ where: { id_cita: request.appointment_id,
        clinica_id: plan.voucher.clinic_id, paciente_id: plan.voucher.patient_id }, transaction, lock: transaction.LOCK.UPDATE });
      if (!appointment) fail('program_link_appointment_not_found', 'No se encuentra una cita de este paciente y esta clínica.', null, 404);
      const claimed = await db.PatientProgramSession.findOne({ where: { appointment_id: appointment.id_cita }, transaction, lock: transaction.LOCK.UPDATE });
      if (claimed) fail('program_link_appointment_claimed', 'Esta cita ya está vinculada a una sesión de programa.');
      const values = appointment.toJSON ? appointment.toJSON() : appointment;
      if (require('../lib/appointment-import-review').importReviewVersion(values) !== request.expected_appointment_revision) {
        fail('program_link_appointment_changed', 'La cita ha cambiado desde que la abriste. Actualiza antes de vincularla; no se ha modificado ninguna cita.');
      }
      const review = require('../lib/appointment-import-review').appointmentImportReview(values);
      if (review?.pending_assignment?.length || review?.resources_need_review) fail('program_link_import_review_required', 'Completa primero la revisión del tratamiento, la cabina y el profesional importados.');
      const resolved = compatibleLinkedAppointment(session, values);
      assertRelativeSessions([resolved]);
      const treatment = await loadScopedTreatment({ db, treatmentId: session.treatment_ids[0], clinic: plan.clinic, transaction });
      const config = json(treatment?.clinical_config || {});
      if (!treatment?.activo || ['draft', 'obsolete'].includes(config.catalog_status)) fail('program_link_treatment_inactive', 'El tratamiento debe estar activo antes de vincular esta cita.');
      const roomIds = [...new Set(resolved.linked_resources.map(phase => Number(phase.installation_id)))];
      const doctorIds = [...new Set(resolved.linked_resources.flatMap(phase => phase.doctor_ids.map(Number)))];
      const [rooms, doctors] = await Promise.all([
        db.Instalacion.findAll({ where: { id: { [db.Sequelize.Op.in]: roomIds }, clinica_id: plan.voucher.clinic_id, activo: true }, transaction, lock: transaction.LOCK.SHARE }),
        db.DoctorClinica.findAll({ where: { doctor_id: { [db.Sequelize.Op.in]: doctorIds }, clinica_id: plan.voucher.clinic_id, activo: true, recibe_citas: true }, transaction, lock: transaction.LOCK.SHARE }),
      ]);
      if (roomIds.some(id => !rooms.some(room => Number(room.id) === id)) || doctorIds.some(id => !doctors.some(doctor => Number(doctor.doctor_id) === id))) {
        fail('program_link_resources_mismatch', 'La sala o el profesional no están disponibles en esta clínica.');
      }
      const assignedMachines = resolved.linked_resources.flatMap(phase => (phase.equipment || []).map(unit => ({ ...unit, start_at: phase.start_at, end_at: phase.end_at })));
      if (assignedMachines.length) {
        if (!db.AppointmentBookingOccupancy) fail('program_link_resources_mismatch', 'No se encuentra la reserva de maquinaria de esta cita.');
        const occupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: appointment.id_cita, resource_kind: 'equipment' }, transaction, lock: transaction.LOCK.SHARE });
        if (assignedMachines.some(unit => !occupancy.some(row => row.resource_key === `equipment:${unit.id}`
          && new Date(row.start_at) <= new Date(unit.start_at) && new Date(row.end_at) >= new Date(unit.end_at)))) {
          fail('program_link_resources_mismatch', 'La maquinaria no tiene una reserva acreditada para las fases de esta cita.');
        }
      }
      const series = plan.sessions.map(row => row.key === session.key
        ? { ...row, start_at: new Date(values.inicio).toISOString(), end_at: new Date(values.fin).toISOString() } : row);
      const issues = seriesIssues(series, plan.snapshot.cadence, plan.timeZone);
      if (issues.length) fail('program_cadence_conflict', 'La cita no respeta el orden o la pauta del programa.', { issues });
      if (1 + plan.sessions.filter(row => row.scheduling_status === 'reserved').length > Number(plan.voucher.available_units)) fail('program_units_insufficient', 'No quedan sesiones disponibles sin reservar.');
      const snapshot = { ...plan.snapshot.appointments[session.position], booking_profile: resolved.booking_profile,
        duration_minutes: resolved.duration_minutes, ...(resolved.duration_selection ? { duration_selection: resolved.duration_selection } : {}),
        program_cadence: plan.snapshot.cadence, linked_appointment: { id: Number(appointment.id_cita), source_system: values.source_system || null } };
      const record = session.record || await db.PatientProgramSession.create({ voucher_id: plan.voucher.id,
        session_key: session.key, position: session.position, snapshot_sha256: plan.snapshot.sha256, snapshot }, { transaction });
      await record.update({ appointment_id: appointment.id_cita, snapshot }, { transaction });
      const existingMetadata = json(values.import_metadata || {});
      // The original source, states, notifications, booking occupancy and all
      // clinical/economic evidence stay intact. This adds only a server-owned
      // purchased-unit relation; no consumption or payment is inferred.
      await appointment.update({ voucher_id: plan.voucher.id, updated_by: options.actorId,
        import_metadata: { ...existingMetadata, program_session: { session_id: String(record.id), key: session.key,
          linked_from_individual: { actor_id: options.actorId, linked_at: now().toISOString(),
            request_sha256: request.request_sha256, snapshot_sha256: plan.snapshot.sha256,
            original_source_system: values.source_system || null, original_source_reference: values.source_reference || null } } } }, { transaction });
      if (!db.PatientOperationalEvent) fail('program_link_activity_unavailable', 'No se puede registrar la actividad de esta vinculación.', null, 503);
      await db.PatientOperationalEvent.create({ patient_id: plan.voucher.patient_id, clinic_id: plan.voucher.clinic_id,
        actor_user_id: options.actorId, event_type: 'appointment.program_linked', source: 'agenda', channel: null, occurred_at: now(),
        metadata: { appointment_id: Number(appointment.id_cita), program_session_key: session.key,
          program_name: plan.snapshot.name, session_number: session.position + 1, snapshot_sha256: plan.snapshot.sha256,
          preserved_schedule: true, consumed_units: 0, payment_created: false } }, { transaction });
      const result = { voucher_id: plan.voucher.public_id, sessions: [{ key: session.key, appointment_id: Number(appointment.id_cita),
        action: 'linked', start_at: new Date(values.inicio).toISOString(), end_at: new Date(values.fin).toISOString() }],
        prior_pending_keys: plan.sessions.filter(row => row.position < session.position && row.scheduling_status === 'pending').map(row => row.key),
        following_pending_keys: plan.sessions.filter(row => row.position > session.position && row.scheduling_status === 'pending').map(row => row.key),
        consumed_units: 0, payment_created: false, reminders_changed: false, replayed: false };
      await db.PatientProgramBookingRequest.create({ voucher_id: plan.voucher.id, request_key: request.request_key,
        request_sha256: request.request_sha256, result, created_by: options.actorId }, { transaction });
      return result;
    });
  }
  return { read, propose, book, linkAppointment };
}

// Existing voucher ledger remains the ONLY economic source of consumed units.
async function consumeProgramSession({ db, appointment, voucher, transaction, actorId }) {
  if (!programBookingEnabled()) return { consumed: false, reason: 'program_booking_disabled' };
  const session = await db.PatientProgramSession.findOne({ where: { voucher_id: voucher.id, appointment_id: appointment.id_cita }, transaction, lock: transaction.LOCK.UPDATE });
  if (!session || Number(appointment.clinica_id) !== Number(voucher.clinic_id) || Number(appointment.paciente_id) !== Number(voucher.patient_id)) fail('program_session_not_found', 'La cita no corresponde a una sesión de este programa.');
  if (voucher.budget_id == null) {
    const entry = require('../lib/patient-program-enrollment').readProgramEnrollment(voucher, { required: true });
    const position = entry.appointments.findIndex(row=>row.key===session.session_key);
    if (position < 0 || Number(session.position)!==position || session.snapshot_sha256!==entry.sha256) fail('program_session_inconsistent', 'La sesión no coincide con la composición registrada del programa.');
    if (position < (entry.enrollment?.start_from_position || 1) - 1) fail('program_session_unrecorded', 'No se puede consumir una sesión anterior al registro del programa.');
  }
  if (session.consumption_movement_id) return { consumed: false, already_consumed: true, movement_id: String(session.consumption_movement_id) };
  if (!require('../lib/appointment-care').hasCompletedAppointmentCare(appointment) || voucher.status !== 'active' || Number(voucher.available_units) < 1) return { consumed: false, reason: 'program_session_not_consumable' };
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
  read: options => service().read(options), propose: options => service().propose(options), book: options => service().book(options),
  linkAppointment: options => service().linkAppointment(options) };
