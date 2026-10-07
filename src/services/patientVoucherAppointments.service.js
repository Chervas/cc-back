'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const appointmentAutomationV2Runtime = require('./appointmentAutomationV2Runtime.service');
const { resolveClinicTimezone, formatDateLocal } = require('../lib/availability-calendar');
const { parseSeriesStart, buildSeriesSlots } = require('../lib/voucher-schedule-calendar');
const { activeAppointmentWhere, inspectSeries } = require('./voucherScheduleAvailability.service');
const { bookingCapabilities, requireOperationalProfile, loadScopedTreatment, assertTreatmentBookingVisibility, parseClinicalConfig } = require('./treatmentBookingProfile.service');
const { loadBookingContext } = require('./appointmentBookingAvailability.service');
const { bookingProfileDurationMinutes } = require('../lib/booking-profile');
const { durationSelectionForRequest, resolveBookingProfileDuration } = require('../lib/booking-profile-duration');
const { solveBookingProfile } = require('../lib/booking-profile-solver');
const { mutateAppointmentBooking } = require('./appointmentBookingCommand.service');
const bookingReplay = require('../lib/voucher-booking-replay');
const { bookingPlanHash } = require('../lib/booking-plan-receipt');

const {
  sequelize,
  PatientVoucher,
  PatientVoucherMovement,
  CitaPaciente,
  Tratamiento,
  DoctorClinica,
  Instalacion,
  Usuario,
} = db;

function domainError(statusCode, code, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function clean(value, max = 255) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// HTTP selections are data, not a way to introduce phase keys/prototypes. The
// solver checks resource eligibility, but intentionally ignores unknown keys.
function selectionRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && (Object.getPrototypeOf(prototype) !== null
    || Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value?.name !== 'Object')) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string'
    && !['__proto__', 'prototype', 'constructor'].includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

function normalizedSelections(value, profile) {
  if (!selectionRecord(value)) throw domainError(400, 'voucher_schedule_selection_invalid', 'Revisa la selección de fases y recursos.');
  const phaseKeys = new Set((profile?.phases || []).map(phase => phase.key));
  const normalized = Object.create(null);
  for (const [key, choice] of Object.entries(value)) {
    if (!phaseKeys.has(key) || !selectionRecord(choice)) {
      throw domainError(400, 'voucher_schedule_selection_invalid', 'La fase elegida no pertenece a esta cita.');
    }
    const phaseSelection = Object.create(null);
    for (const [field, value] of Object.entries(choice)) {
      const id = (typeof value === 'number' || (typeof value === 'string' && value.trim())) ? positiveInteger(value) : null;
      if (!['doctor_id', 'installation_id'].includes(field) || !id) {
        throw domainError(400, 'voucher_schedule_selection_invalid', 'Selecciona identificadores de cabina y profesional válidos.');
      }
      phaseSelection[field] = id;
    }
    normalized[key] = phaseSelection;
  }
  return normalized;
}

function selectionsForSeries(payload, profile, count, doctorId, installationId) {
  const hasCommon = Object.hasOwn(payload, 'booking_selection');
  const hasPerSequence = Object.hasOwn(payload, 'booking_selections_by_sequence');
  if (hasCommon && hasPerSequence) {
    throw domainError(400, 'voucher_schedule_selection_invalid', 'Elige una selección común o una selección por cita, no ambas.');
  }
  const result = new Map();
  if (hasPerSequence) {
    const choices = payload.booking_selections_by_sequence;
    if (!profile || !selectionRecord(choices) || Object.keys(choices).length !== count
      || Object.keys(choices).some(key => !/^[1-9]\d*$/.test(key) || Number(key) > count)
      || Array.from({ length: count }, (_, index) => String(index + 1)).some(key => !Object.hasOwn(choices, key))) {
      throw domainError(400, 'voucher_schedule_selection_invalid', 'Conserva la selección de cada cita de la serie.');
    }
    for (let sequence = 1; sequence <= count; sequence++) result.set(sequence, normalizedSelections(choices[String(sequence)], profile));
  } else {
    const common = hasCommon ? normalizedSelections(payload.booking_selection, profile)
      : profile?.phases.length === 1 && profile.phases[0].professionals.mode === 'any'
        ? { [profile.phases[0].key]: { doctor_id: doctorId, installation_id: installationId } } : {};
    for (let sequence = 1; sequence <= count; sequence++) result.set(sequence, common);
  }
  return result;
}

async function loadVoucher(publicId, transaction = null, lock = false, identityOnly = false) {
  const voucher = await PatientVoucher.findOne({
    where: { public_id: clean(publicId, 36) },
    transaction,
    ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!voucher) throw domainError(404, 'voucher_not_found', 'Bono no encontrado.');
  // A committed receipt is read before mutable status/balance/catalog checks.
  // Identity/tenant verification still happens in the replay helper.
  if (identityOnly) return voucher;
  if (voucher.source_system === 'treatment_program') {
    throw domainError(409, 'program_batch_booking_pending', 'La planificación de este programa requiere el planificador por citas y sesiones; no puede agendarse como un bono simple.');
  }
  if (!['active', 'pending'].includes(voucher.status)) {
    throw domainError(409, 'voucher_not_schedulable', 'Este bono no admite nuevas citas.');
  }
  return voucher;
}

async function resources({ publicId }) {
  const voucher = await loadVoucher(publicId);
  const [doctorLinks, installations] = await Promise.all([
    DoctorClinica.findAll({
      where: { clinica_id: voucher.clinic_id, activo: true, recibe_citas: true },
      attributes: ['doctor_id'],
      order: [['doctor_id', 'ASC']],
    }),
    Instalacion.findAll({
      where: { clinica_id: voucher.clinic_id, activo: true },
      attributes: ['id', 'nombre', 'tipo', 'default_duracion_minutos'],
      order: [['orden_visualizacion', 'ASC'], ['nombre', 'ASC']],
    }),
  ]);
  const doctorIds = doctorLinks.map((link) => Number(link.doctor_id));
  const doctors = doctorIds.length
    ? await Usuario.findAll({
      where: { id_usuario: { [Op.in]: doctorIds } },
      attributes: ['id_usuario', 'nombre', 'apellidos', 'avatar'],
      order: [['nombre', 'ASC'], ['apellidos', 'ASC']],
    })
    : [];
  return {
    doctors: doctors.map((doctor) => ({
      id: Number(doctor.id_usuario),
      name: [doctor.nombre, doctor.apellidos].filter(Boolean).join(' '),
      avatar: doctor.avatar || null,
    })),
    installations: installations.map((installation) => ({
      id: Number(installation.id),
      name: installation.nombre,
      type: installation.tipo,
      default_duration_minutes: positiveInteger(installation.default_duracion_minutos),
    })),
  };
}

async function buildPlan({ publicId, payload, transaction = null, lockVoucher = false, sealPlan = false }) {
  const voucher = await loadVoucher(publicId, transaction, lockVoucher);
  const clinic = await db.Clinica.findByPk(voucher.clinic_id, {
    attributes: ['id_clinica', 'configuracion', 'grupoClinicaId', 'equipment_booking_enabled'], transaction,
  });
  if (!clinic) throw domainError(404, 'voucher_schedule_clinic_not_found', 'Clínica no encontrada.');
  const timeZone = resolveClinicTimezone(clinic);
  const treatment = await loadScopedTreatment({ db, treatmentId: voucher.treatment_id, clinic, transaction });
  const physicalTemplate = parseClinicalConfig(treatment).booking_profile;
  // A chosen duration instantiates ONLY explicit variable physical phases.
  // Fixed-profile legacy totals keep their existing geometry/conflict checks;
  // neither a catalog null nor a room default supplies a fictitious 30 minutes.
  const variableDuration = physicalTemplate?.phases?.some(phase => phase.duration_minutes == null || phase.duration_minutes === '');
  const requestedDuration = variableDuration || Object.hasOwn(payload, 'phase_durations')
    ? durationSelectionForRequest(treatment, payload) : undefined;
  const bookingProfile = requireOperationalProfile(treatment, { durationSelection: requestedDuration });
  // Seal semantic minutes, not whether the client happened to include the
  // redundant total next to its explicit phase choices. Preview and commit
  // must freeze the same complete duration receipt for a variable template.
  const durationSelection = variableDuration
    ? resolveBookingProfileDuration(physicalTemplate, { durationSelection: requestedDuration }).duration_selection
    : requestedDuration;
  const startAt = parseSeriesStart(payload.start_at, timeZone);
  if (Number.isNaN(startAt.getTime()) || startAt <= new Date()) {
    throw domainError(400, 'voucher_schedule_start_invalid', 'Elige una primera cita futura.');
  }
  await assertTreatmentBookingVisibility({ db, treatment, transaction,
    appointmentValues: { clinica_id: voucher.clinic_id, paciente_id: voucher.patient_id,
      tratamiento_id: voucher.treatment_id, voucher_id: voucher.id, fin: startAt } });
  const linkedAppointments = await CitaPaciente.findAll({
    where: {
      voucher_id: voucher.id,
      ...activeAppointmentWhere(Op),
    },
    attributes: ['id_cita'],
    transaction,
  });
  const linkedAppointmentIds = linkedAppointments.map((appointment) => Number(appointment.id_cita));
  const consumedMovements = linkedAppointmentIds.length
    ? await PatientVoucherMovement.findAll({
      where: {
        voucher_id: voucher.id,
        appointment_id: { [Op.in]: linkedAppointmentIds },
        movement_type: 'consumption',
      },
      attributes: ['appointment_id'],
      transaction,
    })
    : [];
  const consumedAppointmentIds = new Set(
    consumedMovements.map((movement) => Number(movement.appointment_id)),
  );
  const reservedUnits = linkedAppointmentIds.filter(
    (appointmentId) => !consumedAppointmentIds.has(appointmentId),
  ).length;
  const availableToSchedule = Math.max(0, Math.floor(Number(voucher.available_units)) - reservedUnits);
  const count = positiveInteger(payload.count) || availableToSchedule;
  const maxCount = Math.min(30, availableToSchedule);
  if ((payload.count != null && !positiveInteger(payload.count)) || count <= 0 || count > maxCount) {
    throw domainError(400, 'voucher_schedule_count_invalid', 'El número de citas supera las sesiones pendientes de agendar.', {
      available: maxCount,
      reserved: reservedUnits,
    });
  }
  const intervalDays = positiveInteger(payload.interval_days) || 7;
  if (payload.interval_days != null && (!positiveInteger(payload.interval_days) || intervalDays > 366)) {
    throw domainError(400, 'voucher_schedule_interval_invalid', 'El intervalo debe ser de 1 a 366 días.');
  }
  const durationMinutes = positiveInteger(payload.duration_minutes)
    || (bookingProfile ? bookingProfileDurationMinutes(bookingProfile) : null)
    || positiveInteger(treatment?.duracion_min);
  if (!durationMinutes) throw domainError(422, 'booking_duration_required',
    'Elige la duración de esta cita antes de buscar disponibilidad o guardarla.',
    { duration_requirements: { required: true, input: 'duration_minutes', phases: [] }, can_force: false });
  if ((payload.duration_minutes != null && !positiveInteger(payload.duration_minutes))
    || durationMinutes < (bookingProfile ? 1 : 10) || durationMinutes > (bookingProfile ? 1440 : 480)) {
    throw domainError(400, 'voucher_schedule_duration_invalid', 'La duración de la cita no es válida.');
  }
  const doctorId = positiveInteger(payload.doctor_id);
  const installationId = positiveInteger(payload.installation_id);
  if (payload.doctor_id != null && payload.doctor_id !== '' && !doctorId) {
    throw domainError(400, 'voucher_schedule_doctor_invalid', 'El profesional no es válido.');
  }
  if (payload.installation_id != null && payload.installation_id !== '' && !installationId) {
    throw domainError(400, 'voucher_schedule_installation_invalid', 'La instalación no es válida.');
  }
  const selectionsBySequence = selectionsForSeries(payload, bookingProfile, count, doctorId, installationId);
  let doctor = null;
  let installation = null;
  if (doctorId) {
    doctor = await DoctorClinica.findOne({
      where: { doctor_id: doctorId, clinica_id: voucher.clinic_id, activo: true, recibe_citas: true },
      include: [{ model: db.DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] }],
      transaction,
    });
    if (!doctor) throw domainError(400, 'voucher_schedule_doctor_invalid', 'El profesional no atiende citas en esta clínica.');
  }
  if (installationId) {
    installation = await Instalacion.findOne({
      where: { id: installationId, clinica_id: voucher.clinic_id, activo: true },
      include: [{ model: db.InstalacionHorario, as: 'horarios' }, { model: db.InstalacionBloqueo, as: 'bloqueos' }],
      transaction,
    });
    if (!installation) throw domainError(400, 'voucher_schedule_installation_invalid', 'La instalación no está disponible.');
  }
  const slots = buildSeriesSlots({ startAt, count, intervalDays, durationMinutes, timeZone });
  let result;
  if (bookingProfile) {
    const context = await loadBookingContext({ db, clinic, profile: bookingProfile, start: slots[0].start,
      end: slots[slots.length - 1].end, transaction, occupancyEnabled: true,
      patientId: voucher.patient_id,
      dates: slots.flatMap((slot) => [formatDateLocal(slot.start, timeZone), formatDateLocal(slot.end, timeZone)]) });
    result = slots.map((slot) => {
      const selections = selectionsBySequence.get(slot.sequence);
      const solution = solveBookingProfile({ profile: bookingProfile, start: slot.start, ...context, selections });
      const solutionStart = solution?.start_at == null ? slot.start : new Date(solution.start_at);
      const solutionEnd = new Date(solution?.end_at);
      const valid = solution && solutionStart.getTime() === slot.start.getTime() && solutionEnd.getTime() === slot.end.getTime()
        && (bookingProfile.version !== 4 || (solution.start_at != null && solution.capacity_fully_verified === true
          && Array.isArray(solution.attention_requirements_pending) && !solution.attention_requirements_pending.length));
      return { sequence: slot.sequence, start_at: (valid ? solutionStart : slot.start).toISOString(), end_at: (valid ? solutionEnd : slot.end).toISOString(),
        conflicts: valid ? [] : [{ code: 'BOOKING_UNAVAILABLE', resource: 'treatment', title: 'No hay disponibilidad para el perfil del tratamiento' }],
        ...(valid ? { phases: solution.phases, warnings: solution.warnings, requires_priority_acknowledgement: solution.requires_priority_acknowledgement,
          ...(sealPlan ? { booking_plan_sha256: bookingPlanHash(bookingProfile, solution) } : {}),
          ...(bookingProfile.version === 4 ? { capacity_fully_verified: true, attention_requirements_pending: [] } : {}) } : {}) };
    });
  } else {
    result = await inspectSeries({ db, slots, clinicId: Number(voucher.clinic_id), doctorId, installationId,
      doctor, installation, timeZone, transaction });
  }
  if (voucher.expires_at) {
    const expires = new Date(voucher.expires_at);
    result.forEach((slot) => {
      if (new Date(slot.end_at) > expires) slot.conflicts.push({
        code: 'VOUCHER_EXPIRED', resource: 'voucher', title: 'La cita queda fuera de la vigencia del bono',
        start_at: slot.start_at, end_at: slot.end_at,
      });
    });
  }
  return {
    voucher: {
      id: voucher.public_id,
      name: voucher.name,
      available_units: Number(voucher.available_units),
      available_to_schedule: availableToSchedule,
      reserved_units: reservedUnits,
      unit_label: voucher.unit_label,
    },
    configuration: {
      count,
      interval_days: intervalDays,
      duration_minutes: durationMinutes,
      doctor_id: doctorId,
      installation_id: installationId,
      timezone: timeZone,
    },
    appointments: result,
    has_conflicts: result.some((slot) => slot.conflicts.length),
    treatment,
    rawVoucher: voucher,
    selectionsBySequence,
    durationSelection,
    bookingProfile,
    physicalTemplate,
  };
}

function serializePlan(plan) {
  const { rawVoucher, treatment, selectionsBySequence, durationSelection, bookingProfile, physicalTemplate, ...serializable } = plan;
  return {
    ...serializable,
    treatment: treatment ? {
      id: Number(treatment.id_tratamiento),
      name: treatment.nombre,
    } : null,
  };
}

function assertReplayRuntime() {
  if (!bookingCapabilities().simple) throw domainError(409, 'voucher_booking_runtime_unavailable',
    'La reserva verificable del bono todavía no está habilitada.');
  if (!db.PatientOperationalEvent) throw domainError(503, 'voucher_booking_replay_unavailable',
    'No se puede verificar la reserva del bono. No se creará otra cita.');
}

async function replayEvent(voucher, stage, requestKey, transaction) {
  const rows = await db.PatientOperationalEvent.findAll({ transaction,
    where: { patient_id: voucher.patient_id, clinic_id: voucher.clinic_id, source: bookingReplay.SOURCE,
      event_type: bookingReplay.eventType(stage, requestKey) },
    order: [['occurred_at', 'DESC'], ['id', 'DESC']], limit: 2 });
  if (rows.length > 1) throw domainError(409, 'voucher_booking_receipt_invalid', 'Hay más de una referencia para esta reserva. No se creará otra cita.');
  return rows.length ? bookingReplay.readMetadata(rows[0], voucher, stage, requestKey) : null;
}

async function appendReplayEvent(voucher, stage, metadata, transaction, actorId = null) {
  return db.PatientOperationalEvent.create({ patient_id: voucher.patient_id, clinic_id: voucher.clinic_id,
    actor_user_id: actorId, event_type: bookingReplay.eventType(stage, metadata.request_key), source: bookingReplay.SOURCE,
    channel: 'internal', metadata, occurred_at: new Date() }, { transaction });
}

async function preview(input) {
  if (!bookingReplay.enabled()) return serializePlan(await buildPlan(input));
  assertReplayRuntime();
  const actorId = positiveInteger(input.actorId);
  if (!actorId) throw domainError(401, 'unauthenticated', 'Usuario no autenticado.');
  return sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const plan = await buildPlan({ ...input, transaction, lockVoucher: true, sealPlan: true });
    if (plan.has_conflicts) return { ...serializePlan(plan), booking_replay_supported: true };
    const prepared = bookingReplay.preparedMetadata(plan, actorId);
    await appendReplayEvent(plan.rawVoucher, 'prepared', prepared, transaction, actorId);
    return { ...serializePlan(plan), booking_replay_supported: true,
      booking_request_key: prepared.request_key, booking_request_sha256: prepared.request_sha256 };
  });
}

async function persistPlan({ plan, actorId, payload, transaction, durable = false, prepared = null }) {
    if (plan.has_conflicts) {
      throw domainError(409, 'voucher_schedule_conflicts', 'Hay conflictos en la serie. Ajusta las fechas antes de confirmar.', {
        appointments: plan.appointments,
      });
    }
    const appointments = [];
    const managed = durable && plan.bookingProfile?.version === 4
      ? require('./appointmentVisitManaged.service').current() : null;
    const clinic = managed ? await db.Clinica.findByPk(plan.rawVoucher.clinic_id, { transaction }) : null;
    for (const slot of plan.appointments) {
      const values = {
        clinica_id: plan.rawVoucher.clinic_id,
        paciente_id: plan.rawVoucher.patient_id,
        doctor_id: plan.configuration.doctor_id,
        instalacion_id: plan.configuration.installation_id,
        tratamiento_id: plan.rawVoucher.treatment_id,
        voucher_id: plan.rawVoucher.id,
        created_by: actorId,
        updated_by: actorId,
        titulo: plan.treatment?.nombre || plan.rawVoucher.name,
        nota: `Sesión ${slot.sequence} de ${plan.configuration.count} · ${plan.rawVoucher.name}`,
        motivo: 'Sesión planificada desde bono',
        tipo_cita: 'continuacion',
        estado: 'pendiente',
        inicio: slot.start_at,
        fin: slot.end_at,
      };
      const visitBirth = managed ? await managed.prepareVoucherBirth({ values, clinic, actorId, profile: plan.bookingProfile,
        parentRequestKey: prepared.request_key, parentRequestSha256: prepared.request_sha256,
        sequence: slot.sequence, slotPlanSha256: slot.booking_plan_sha256, transaction }) : null;
      appointments.push(bookingCapabilities().simple
        ? await mutateAppointmentBooking({ db, appointmentValues: values, transaction,
          selections: plan.selectionsBySequence.get(slot.sequence), priorityAcknowledged: payload.booking_priority_acknowledged === true,
          durationSelection: plan.durationSelection,
          ...(visitBirth ? { visitBirth } : {}),
          ...(durable && slot.booking_plan_sha256 ? { expectedPlanSha256: slot.booking_plan_sha256 } : {}),
          persist: ({ values: resolved, existing, transaction: tx, sealedBirth }) => sealedBirth ? existing : CitaPaciente.create(resolved, { transaction: tx }) })
        : await CitaPaciente.create(values, { transaction }));
    }
    return appointments;
}

async function create({ publicId, actorId, payload }) {
  const durable = bookingReplay.enabled();
  if (!durable && (Object.hasOwn(payload, 'booking_request_key') || Object.hasOwn(payload, 'booking_request_sha256'))) {
    throw domainError(409, 'voucher_booking_replay_disabled', 'La recuperación de esta reserva todavía no está habilitada. No se creará otra cita.');
  }
  let requestKey, requestHash;
  if (durable) {
    assertReplayRuntime();
    if (!positiveInteger(actorId)) throw domainError(401, 'unauthenticated', 'Usuario no autenticado.');
    actorId = positiveInteger(actorId); requestKey = bookingReplay.key(payload.booking_request_key); requestHash = bookingReplay.sha(payload.booking_request_sha256);
  }
  const execute = async transaction => {
    let prepared;
    if (durable) {
      const voucher = await loadVoucher(publicId, transaction, true, true);
      prepared = await replayEvent(voucher, 'prepared', requestKey, transaction);
      if (!prepared) throw domainError(409, 'voucher_booking_request_not_found', 'Esta propuesta no fue preparada por el servidor para este bono. Comprueba los huecos otra vez.');
      if (prepared.actor_id !== actorId) throw domainError(403, 'voucher_booking_request_forbidden',
        'Esta propuesta pertenece a otra sesión de trabajo. Revisa la agenda antes de preparar otra reserva.');
      if (prepared.request_sha256 !== requestHash) throw domainError(409, 'voucher_booking_request_conflict', 'La propuesta cambió. Comprueba los huecos otra vez.');
      bookingReplay.validatePayload(prepared.intent, payload, normalizedSelections);
      const committed = await replayEvent(voucher, 'committed', requestKey, transaction);
      if (committed) return { created: [], replayed: true, receipt: bookingReplay.receiptFromMetadata(committed, prepared) };
    }
    const plan = await buildPlan({ publicId, transaction, lockVoucher: true, sealPlan: durable,
      payload: durable ? bookingReplay.payloadForIntent(prepared.intent, payload) : payload });
    if (durable && bookingReplay.hash(bookingReplay.intentForPlan(plan, actorId)) !== requestHash) {
      throw domainError(409, 'voucher_booking_plan_changed', 'Los huecos o el tratamiento han cambiado. Comprueba la propuesta otra vez.');
    }
    const created = await persistPlan({ plan, actorId, payload, transaction, durable, prepared });
    const receipt = durable ? bookingReplay.receiptForAppointments(created) : null;
    if (durable) {
      await appendReplayEvent(plan.rawVoucher, 'committed', bookingReplay.committedMetadata(prepared, receipt), transaction, actorId);
      // The native aggregate receipt must exist before any managed voucher
      // intent can claim. All rows/receipts/intents commit or roll back together.
      if (plan.bookingProfile?.version === 4) await require('./appointmentVisitManaged.service').current()
        .finalizeVoucherBirths({ appointments: created, transaction });
    }
    return { created, receipt, replayed: false };
  };
  const outcome = durable || bookingCapabilities().simple
    ? await sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, execute)
    : await sequelize.transaction(execute);
  const created = outcome.created;
  for (const appointment of created) {
    try {
      await appointmentAutomationV2Runtime.enqueueExecutionForCita(appointment, {
        event_name: 'appointment_created',
        user_id: actorId,
        user_role: 'admin',
      });
      await appointmentAutomationV2Runtime.syncScheduledTriggersForCita(appointment, {
        user_id: actorId,
        user_role: 'admin',
      });
    } catch (error) {
      console.error('[voucher-schedule] No se pudo activar la automatización:', error.message);
    }
  }
  if (durable) return { ...outcome.receipt, replayed: outcome.replayed,
    booking_request_key: requestKey, booking_request_sha256: requestHash };
  return {
    created: created.map((appointment) => ({
      id: Number(appointment.id_cita),
      start_at: appointment.inicio,
      end_at: appointment.fin,
      title: appointment.titulo,
    })),
  };
}

module.exports = {
  domainError,
  resources,
  preview,
  create,
};
