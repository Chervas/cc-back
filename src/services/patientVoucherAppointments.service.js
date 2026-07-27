'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const appointmentAutomationV2Runtime = require('./appointmentAutomationV2Runtime.service');

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
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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
  const treatment = voucher.treatment_id
    ? await Tratamiento.findByPk(voucher.treatment_id, {
      attributes: ['id_tratamiento', 'nombre', 'duracion_min'],
      transaction,
    })
    : null;
  const startAt = new Date(payload.start_at);
  if (Number.isNaN(startAt.getTime()) || startAt <= new Date()) {
    throw domainError(400, 'voucher_schedule_start_invalid', 'Elige una primera cita futura.');
  }
  const linkedAppointments = await CitaPaciente.findAll({
    where: {
      voucher_id: voucher.id,
      estado: { [Op.notIn]: ['cancelada', 'reprogramada'] },
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
  if (count <= 0 || count > maxCount) {
    throw domainError(400, 'voucher_schedule_count_invalid', 'El número de citas supera las sesiones pendientes de agendar.', {
      available: maxCount,
      reserved: reservedUnits,
    });
  }
  const intervalDays = positiveInteger(payload.interval_days) || 7;
  const durationMinutes = positiveInteger(payload.duration_minutes)
    || Number(treatment?.duracion_min)
    || 30;
  if (durationMinutes < 10 || durationMinutes > 480) {
    throw domainError(400, 'voucher_schedule_duration_invalid', 'La duración de la cita no es válida.');
  }
  const doctorId = positiveInteger(payload.doctor_id);
  const installationId = positiveInteger(payload.installation_id);
  if (doctorId) {
    const doctor = await DoctorClinica.findOne({
      where: { doctor_id: doctorId, clinica_id: voucher.clinic_id, activo: true, recibe_citas: true },
      transaction,
    });
    if (!doctor) throw domainError(400, 'voucher_schedule_doctor_invalid', 'El profesional no atiende citas en esta clínica.');
  }
  if (installationId) {
    const installation = await Instalacion.findOne({
      where: { id: installationId, clinica_id: voucher.clinic_id, activo: true },
      transaction,
    });
    if (!installation) throw domainError(400, 'voucher_schedule_installation_invalid', 'La instalación no está disponible.');
  }
  const slots = Array.from({ length: count }, (_, index) => {
    const start = new Date(startAt.getTime() + index * intervalDays * 86400000);
    const end = new Date(start.getTime() + durationMinutes * 60000);
    return { sequence: index + 1, start, end };
  });
  const existing = doctorId || installationId
    ? await CitaPaciente.findAll({
      where: {
        clinica_id: voucher.clinic_id,
        estado: { [Op.notIn]: ['cancelada', 'reprogramada'] },
        inicio: { [Op.lt]: slots[slots.length - 1].end },
        fin: { [Op.gt]: slots[0].start },
        [Op.or]: [
          ...(doctorId ? [{ doctor_id: doctorId }] : []),
          ...(installationId ? [{ instalacion_id: installationId }] : []),
        ],
      },
      attributes: ['id_cita', 'doctor_id', 'instalacion_id', 'inicio', 'fin', 'titulo'],
      transaction,
    })
    : [];
  const result = slots.map((slot) => {
    const conflicts = existing.filter((appointment) => (
      new Date(appointment.inicio) < slot.end
      && new Date(appointment.fin) > slot.start
      && (
        (doctorId && Number(appointment.doctor_id) === doctorId)
        || (installationId && Number(appointment.instalacion_id) === installationId)
      )
    ));
    return {
      sequence: slot.sequence,
      start_at: slot.start.toISOString(),
      end_at: slot.end.toISOString(),
      conflicts: conflicts.map((appointment) => ({
        appointment_id: Number(appointment.id_cita),
        title: appointment.titulo || 'Cita ocupada',
        start_at: appointment.inicio,
        end_at: appointment.fin,
        resource: doctorId && Number(appointment.doctor_id) === doctorId ? 'doctor' : 'installation',
      })),
    };
  });
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
  const created = await sequelize.transaction(async (transaction) => {
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
      appointments.push(await CitaPaciente.create({
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
      }, { transaction }));
    }
    return appointments;
  });
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
