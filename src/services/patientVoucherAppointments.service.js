'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const appointmentAutomationV2Runtime = require('./appointmentAutomationV2Runtime.service');
const { resolveClinicTimezone, formatDateLocal } = require('../lib/availability-calendar');
const { parseSeriesStart, buildSeriesSlots } = require('../lib/voucher-schedule-calendar');
const { activeAppointmentWhere, inspectSeries } = require('./voucherScheduleAvailability.service');
const { bookingCapabilities, requireOperationalProfile, loadScopedTreatment } = require('./treatmentBookingProfile.service');
const { loadBookingContext } = require('./appointmentBookingAvailability.service');
const { solveBookingProfile } = require('../lib/booking-profile-solver');
const { mutateAppointmentBooking } = require('./appointmentBookingCommand.service');

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

async function loadVoucher(publicId, transaction = null, lock = false) {
  const voucher = await PatientVoucher.findOne({
    where: { public_id: clean(publicId, 36) },
    transaction,
    ...(lock && transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  if (!voucher) throw domainError(404, 'voucher_not_found', 'Bono no encontrado.');
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
      default_duration_minutes: Number(installation.default_duracion_minutos || 30),
    })),
  };
}

async function buildPlan({ publicId, payload, transaction = null, lockVoucher = false }) {
  const voucher = await loadVoucher(publicId, transaction, lockVoucher);
  const clinic = await db.Clinica.findByPk(voucher.clinic_id, {
    attributes: ['id_clinica', 'configuracion', 'grupoClinicaId'], transaction,
  });
  if (!clinic) throw domainError(404, 'voucher_schedule_clinic_not_found', 'Clínica no encontrada.');
  const timeZone = resolveClinicTimezone(clinic);
  const treatment = await loadScopedTreatment({ db, treatmentId: voucher.treatment_id, clinic, transaction });
  const bookingProfile = requireOperationalProfile(treatment);
  const startAt = parseSeriesStart(payload.start_at, timeZone);
  if (Number.isNaN(startAt.getTime()) || startAt <= new Date()) {
    throw domainError(400, 'voucher_schedule_start_invalid', 'Elige una primera cita futura.');
  }
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
    || (bookingProfile ? bookingProfile.phases.reduce((sum, phase) => sum + phase.duration_minutes, 0) : null)
    || Number(treatment?.duracion_min)
    || 30;
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
      dates: slots.flatMap((slot) => [formatDateLocal(slot.start, timeZone), formatDateLocal(slot.end, timeZone)]) });
    result = slots.map((slot) => {
      const selections = payload.booking_selection || (bookingProfile.phases.length === 1 && bookingProfile.phases[0].professionals.mode === 'any'
        ? { [bookingProfile.phases[0].key]: { doctor_id: doctorId, installation_id: installationId } } : {});
      const solution = solveBookingProfile({ profile: bookingProfile, start: slot.start, ...context, selections });
      const valid = solution && new Date(solution.end_at).getTime() === slot.end.getTime();
      return { sequence: slot.sequence, start_at: slot.start.toISOString(), end_at: slot.end.toISOString(),
        conflicts: valid ? [] : [{ code: 'BOOKING_UNAVAILABLE', resource: 'treatment', title: 'No hay disponibilidad para el perfil del tratamiento' }],
        ...(valid ? { phases: solution.phases, warnings: solution.warnings, requires_priority_acknowledgement: solution.requires_priority_acknowledgement } : {}) };
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
  };
}

async function preview(input) {
  const plan = await buildPlan(input);
  const { rawVoucher, treatment, ...serializable } = plan;
  return {
    ...serializable,
    treatment: treatment ? {
      id: Number(treatment.id_tratamiento),
      name: treatment.nombre,
    } : null,
  };
}

async function create({ publicId, actorId, payload }) {
  const execute = async (transaction) => {
    const plan = await buildPlan({
      publicId,
      payload,
      transaction,
      lockVoucher: true,
    });
    if (plan.has_conflicts) {
      throw domainError(409, 'voucher_schedule_conflicts', 'Hay conflictos en la serie. Ajusta las fechas antes de confirmar.', {
        appointments: plan.appointments,
      });
    }
    const appointments = [];
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
      appointments.push(bookingCapabilities().simple
        ? await mutateAppointmentBooking({ db, appointmentValues: values, transaction,
          selections: payload.booking_selection || {}, priorityAcknowledged: payload.booking_priority_acknowledged === true,
          persist: ({ values: resolved, transaction: tx }) => CitaPaciente.create(resolved, { transaction: tx }) })
        : await CitaPaciente.create(values, { transaction }));
    }
    return appointments;
  };
  const created = bookingCapabilities().simple
    ? await sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, execute)
    : await sequelize.transaction(execute);
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
