'use strict';

const {
  buildWindowsFromHorarios,
  buildDoctorBloqueoRowsForDate,
  buildDoctorAvailabilityContext,
  hasActiveSchedule,
  inAnyWindow,
  formatDateLocal,
  dayIndexFromLocalDate,
} = require('../lib/availability-calendar');

const overlaps = (start, end, rowStart, rowEnd) => start < new Date(rowEnd) && new Date(rowStart) < end;

// Matches the public agenda: a reprogramada/cambio_solicitado appointment still
// occupies its real range. Cancellation is the only state that releases it.
function activeAppointmentWhere(Op) {
  return { estado: { [Op.ne]: 'cancelada' } };
}

function conflict(slot, code, resource, title) {
  return { code, resource, title, start_at: slot.start.toISOString(), end_at: slot.end.toISOString() };
}

async function inspectSeries({ db, slots, clinicId, doctorId, installationId, doctor, installation, timeZone, transaction = null }) {
  const { Op } = db.Sequelize;
  const first = slots[0].start;
  const last = slots[slots.length - 1].end;
  const [clinicHours, doctorBlocks, appointments] = await Promise.all([
    db.ClinicaHorario ? db.ClinicaHorario.findAll({
      where: { clinica_id: clinicId },
      attributes: ['dia_semana', 'activo', 'hora_inicio', 'hora_fin'],
      transaction,
    }) : [],
    doctorId ? db.DoctorBloqueo.findAll({
      where: {
        doctor_id: doctorId,
        [Op.or]: [
          { recurrente: 'none', fecha_inicio: { [Op.lt]: last }, fecha_fin: { [Op.gt]: first } },
          { recurrente: { [Op.ne]: 'none' }, fecha_inicio: { [Op.lte]: last } },
        ],
      },
      include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }],
      transaction,
    }) : [],
    (doctorId || installationId) ? db.CitaPaciente.findAll({
      where: {
        ...activeAppointmentWhere(Op),
        inicio: { [Op.lt]: last },
        fin: { [Op.gt]: first },
        [Op.or]: [
          ...(doctorId ? [{ doctor_id: doctorId }] : []),
          ...(installationId ? [{ instalacion_id: installationId }] : []),
        ],
      },
      // No patient/title/notes or foreign clinic details in this read model.
      attributes: ['doctor_id', 'instalacion_id', 'inicio', 'fin'],
      transaction,
    }) : [],
  ]);
  const clinicHasSchedule = hasActiveSchedule(clinicHours);
  return slots.map((slot) => {
    const date = formatDateLocal(slot.start, timeZone);
    const dow = dayIndexFromLocalDate(date);
    const conflicts = [];
    if (clinicHasSchedule && !inAnyWindow(buildWindowsFromHorarios(clinicHours, dow, date, timeZone), slot.start, slot.end)) {
      conflicts.push(conflict(slot, 'CLINIC_OUT_OF_HOURS', 'clinic', 'Clínica fuera de horario'));
    }
    if (installationId) {
      if (!inAnyWindow(buildWindowsFromHorarios(installation?.horarios || [], dow, date, timeZone), slot.start, slot.end)) {
        conflicts.push(conflict(slot, 'INSTALLATION_OUT_OF_HOURS', 'installation', 'Instalación fuera de horario'));
      }
      if ((installation?.bloqueos || []).some((row) => overlaps(slot.start, slot.end, row.fecha_inicio, row.fecha_fin))) {
        conflicts.push(conflict(slot, 'INSTALLATION_BLOCKED', 'installation', 'Instalación bloqueada'));
      }
      if (appointments.some((row) => Number(row.instalacion_id) === installationId && overlaps(slot.start, slot.end, row.inicio, row.fin))) {
        conflicts.push(conflict(slot, 'INSTALLATION_OVERLAP', 'installation', 'Instalación ocupada'));
      }
    }
    if (doctorId) {
      const context = buildDoctorAvailabilityContext({ doctorId, clinicaId: clinicId, dc: doctor || null, dow, fechaLocal: date, timeZone });
      if (context.dcMissing || !inAnyWindow(context.docWins, slot.start, slot.end)) {
        conflicts.push(conflict(slot, 'STAFF_OUT_OF_HOURS', 'doctor', context.outOfHoursMessage));
      }
      if (buildDoctorBloqueoRowsForDate(doctorBlocks, date, timeZone)
        .some((row) => overlaps(slot.start, slot.end, row.fecha_inicio, row.fecha_fin))) {
        conflicts.push(conflict(slot, 'STAFF_BLOCKED', 'doctor', 'Profesional no disponible'));
      }
      if (appointments.some((row) => Number(row.doctor_id) === doctorId && overlaps(slot.start, slot.end, row.inicio, row.fin))) {
        conflicts.push(conflict(slot, 'STAFF_OVERLAP', 'doctor', 'Profesional ocupado'));
      }
    }
    return { sequence: slot.sequence, start_at: slot.start.toISOString(), end_at: slot.end.toISOString(), conflicts };
  });
}

module.exports = { activeAppointmentWhere, inspectSeries };
