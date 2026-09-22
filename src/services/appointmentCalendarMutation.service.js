'use strict';

const { bookingCapabilities, bookingError } = require('./treatmentBookingProfile.service');
const { resolveInstallationKeys } = require('./appointmentBookingAvailability.service');
const { lockBookingResources } = require('./appointmentBookingCommand.service');
const { buildDoctorAvailabilityContext, buildDoctorBloqueoRowsForDate, buildWindowsFromHorarios,
  resolveClinicTimezone, formatDateLocal, dayIndexFromLocalDate, inAnyWindow, hasActiveSchedule } = require('../lib/availability-calendar');

const overlaps = (a, b, c, d) => new Date(a) < new Date(d) && new Date(c) < new Date(b);

/** Bulk validation of the frozen reservations affected by a calendar change.
 * Only intervals/resource IDs are read, never patient identities or notes.
 * Existing anomalies can be repaired incrementally; a change cannot introduce
 * a newly uncovered phase. No SQL per appointment or candidate time slot.
 */
async function uncoveredPhases({ db, rows, transaction, installationMapping = null }) {
  if (!rows.length) return new Set();
  const { Op } = db.Sequelize;
  const doctorIds = [...new Set(rows.map(r => Number(r.doctor_id)).filter(Boolean))];
  const installationIds = [...new Set(rows.map(r => Number(r.installation_id)).filter(Boolean))];
  const clinicIds = [...new Set(rows.map(r => Number(r.appointment.clinica_id)))];
  const minStart = new Date(Math.min(...rows.map(r => new Date(r.start_at).getTime())));
  const maxEnd = new Date(Math.max(...rows.map(r => new Date(r.end_at).getTime())));
  const [links, rooms, clinics, doctorBlocks, roomBlocks, clinicHours] = await Promise.all([
    doctorIds.length ? db.DoctorClinica.findAll({ where: { doctor_id: { [Op.in]: doctorIds }, clinica_id: { [Op.in]: clinicIds } },
      include: [{ model: db.DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] }], transaction }) : [],
    installationIds.length ? db.Instalacion.findAll({ where: { id: { [Op.in]: installationIds } },
      include: [{ model: db.InstalacionHorario, as: 'horarios' }], transaction }) : [],
    db.Clinica.findAll({ where: { id_clinica: { [Op.in]: clinicIds } }, attributes: ['id_clinica', 'configuracion'], transaction }),
    doctorIds.length ? db.DoctorBloqueo.findAll({ where: { doctor_id: { [Op.in]: doctorIds }, fecha_inicio: { [Op.lt]: maxEnd },
      [Op.or]: [{ fecha_fin: { [Op.gt]: minStart } }, { recurrente: { [Op.ne]: 'none' } }] },
      include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }], transaction }) : [],
    // The caller supplies every physical alias for installation mutations.
    installationIds.length ? db.InstalacionBloqueo.findAll({ where: { instalacion_id: { [Op.in]: installationMapping?.physicalInstallationIds || installationIds },
      fecha_inicio: { [Op.lt]: maxEnd }, fecha_fin: { [Op.gt]: minStart } }, transaction }) : [],
    db.ClinicaHorario.findAll({ where: { clinica_id: { [Op.in]: clinicIds } }, transaction }),
  ]);
  const result = new Set(), cache = new Map();
  for (const row of rows) {
    const clinicId = Number(row.appointment.clinica_id), timeZone = resolveClinicTimezone(clinics.find(c => Number(c.id_clinica) === clinicId));
    const date = formatDateLocal(new Date(row.start_at), timeZone), dow = dayIndexFromLocalDate(date);
    const resourceKey = row.resource_key, key = `${resourceKey}:${clinicId}:${date}`;
    // Equipment rows include turnaround beyond the clinical visit; room/staff
    // phase rows already validate the clinic opening hours for the actual care.
    if (resourceKey.startsWith('equipment:')) continue;
    const clinicKey = `clinic:${clinicId}:${date}`;
    if (!cache.has(clinicKey)) {
      const hours = clinicHours.filter(h => Number(h.clinica_id) === clinicId);
      cache.set(clinicKey, hasActiveSchedule(hours) ? buildWindowsFromHorarios(hours, dow, date, timeZone) : null);
    }
    const clinicWindows = cache.get(clinicKey);
    const phaseKey = `${row.appointment_id}:${resourceKey}:${new Date(row.start_at).toISOString()}`;
    if (clinicWindows && !inAnyWindow(clinicWindows, new Date(row.start_at), new Date(row.end_at))) result.add(phaseKey);
    if (resourceKey.startsWith('patient:')) continue;
    if (!cache.has(key)) {
      if (resourceKey.startsWith('doctor:')) {
        const doctorId = Number(row.doctor_id), dc = links.find(l => Number(l.doctor_id) === doctorId && Number(l.clinica_id) === clinicId);
        const context = buildDoctorAvailabilityContext({ doctorId, clinicaId: clinicId, dc, dow, fechaLocal: date, timeZone });
        cache.set(key, { windows: dc?.activo && dc?.recibe_citas ? context.docWins : [],
          blocks: buildDoctorBloqueoRowsForDate(doctorBlocks.filter(b => Number(b.doctor_id) === doctorId), date, timeZone) });
      } else {
        const room = rooms.find(r => Number(r.id) === Number(row.installation_id));
        cache.set(key, { windows: room?.activo ? buildWindowsFromHorarios(room.horarios || [], dow, date, timeZone) : [],
          blocks: roomBlocks.filter(b => installationMapping
            ? installationMapping.keys.get(Number(b.instalacion_id)) === resourceKey
            : Number(b.instalacion_id) === Number(row.installation_id)) });
      }
    }
    const value = cache.get(key);
    if (!inAnyWindow(value.windows, new Date(row.start_at), new Date(row.end_at))
      || value.blocks.some(b => overlaps(row.start_at, row.end_at, b.fecha_inicio, b.fecha_fin))) result.add(phaseKey);
  }
  return result;
}

async function withCalendarMutation({ db, doctorId = null, installationId = null, clinicId = null, clinic = null, mutate,
  enabled = bookingCapabilities().simple, now = new Date(), transaction: suppliedTransaction = null }) {
  if ((!doctorId && !installationId && !clinicId) || [doctorId, installationId, clinicId].filter(v => v !== null)
    .some(v => !Number.isSafeInteger(Number(v)) || Number(v) <= 0)) throw Error('CALENDAR_MUTATION_SCOPE_INVALID');
  const execute = async transaction => {
    if (transaction.options?.isolationLevel !== 'READ COMMITTED') throw Error('booking_requires_read_committed');
    if (!enabled) return mutate(transaction);
    // Shared by bookings, exclusive only when editing the clinic's opening
    // hours. Unrelated bookings remain parallel; there is no global clinic mutex.
    if (clinicId) {
      const found = await db.Clinica.findByPk(clinicId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!found) throw bookingError('clinic_not_found', 'Clínica no encontrada.', null, 404);
    }
    if (installationId && !clinic) {
      const room = await db.Instalacion.findByPk(installationId, { transaction });
      if (!room) throw bookingError('installation_not_found', 'Instalación no encontrada.', null, 404);
      clinic = await db.Clinica.findByPk(room.clinica_id, { transaction });
    }
    const mapping = installationId ? await resolveInstallationKeys({ db, clinic, installationIds: [Number(installationId)], transaction, enabled: true }) : null;
    const keys = [...(doctorId ? [`doctor:${Number(doctorId)}`] : []), ...(mapping ? [mapping.keys.get(Number(installationId))] : [])];
    await lockBookingResources({ db, resourceKeys: keys, transaction });
    const { Op } = db.Sequelize;
    const rows = await db.AppointmentBookingOccupancy.findAll({ where: { ...(clinicId ? {} : { resource_key: { [Op.in]: keys } }), end_at: { [Op.gt]: now } },
      include: [{ model: db.CitaPaciente, as: 'appointment', required: true, attributes: ['clinica_id'], where: { estado: { [Op.ne]: 'cancelada' }, ...(clinicId ? { clinica_id: Number(clinicId) } : {}) } }],
      order: [['start_at', 'ASC']], limit: 2001, transaction });
    if (rows.length > 2000) throw bookingError('booking_calendar_review_required', 'Hay muchas reservas afectadas. Revisa el cambio de horario por partes.');
    if (clinicId) await lockBookingResources({ db, resourceKeys: rows.map(r => r.resource_key), transaction });
    // Each equivalent room must observe a block entered under any of its aliases.
    // Preserve the actual booked room for its own opening hours; alias block
    // projection is supplied to the validator below.
    const before = await uncoveredPhases({ db, rows, transaction, installationMapping: mapping });
    const value = await mutate(transaction);
    const after = await uncoveredPhases({ db, rows, transaction, installationMapping: mapping });
    const introduced = [...after].filter(key => !before.has(key));
    if (introduced.length) throw bookingError('booking_calendar_conflict',
      'El cambio dejaría citas reservadas fuera de horario o dentro de un bloqueo. Reprograma esas citas antes de guardar el cambio.',
      { affected_appointments: new Set(introduced.map(key => key.split(':')[0])).size });
    return value;
  };
  return suppliedTransaction ? execute(suppliedTransaction) : db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, execute);
}

// Account merges must not rewrite a doctor's identity underneath immutable
// booking/budget snapshots. This rare administrative operation fails closed
// with an actionable review instead of partially migrating clinical history.
async function assertDoctorIdentityMutable({ db, doctorIds, transaction, enabled = bookingCapabilities().simple }) {
  if (!enabled) return;
  await lockBookingResources({ db, resourceKeys: doctorIds.map(id => `doctor:${Number(id)}`), transaction });
  const { Op, fn, col, where, literal } = db.Sequelize;
  const refersToDoctor = (column, path) => ({ [Op.or]: doctorIds.map(id =>
    where(fn('JSON_CONTAINS', fn('JSON_EXTRACT', col(column), literal(db.sequelize.escape(path))), JSON.stringify(Number(id))), 1)) });
  const evidence = await Promise.all([
    db.AppointmentBookingOccupancy.findOne({ where: { doctor_id: { [Op.in]: doctorIds } }, attributes: ['id'], transaction }),
    db.Tratamiento.findOne({ where: refersToDoctor('clinical_config', '$.booking_profile.phases[*].professionals.ids'), attributes: ['id_tratamiento'], transaction }),
    db.PatientProgramSession.findOne({ where: refersToDoctor('snapshot', '$.booking_profile.phases[*].professionals.ids'), attributes: ['id'], transaction }),
    db.EconomicBudgetVersion.findOne({ where: refersToDoctor('lines', '$[*].program_snapshot.appointments[*].booking_profile.phases[*].professionals.ids'), attributes: ['id'], transaction }),
  ]);
  if (evidence.some(Boolean)) throw bookingError('booking_calendar_identity_review_required',
    'Este profesional figura en tratamientos o reservas con historial protegido. Revisa sus asignaciones antes de fusionar las cuentas.');
}

function sendCalendarMutationError(error, res) {
  if (!/^booking_calendar_/.test(error?.code || '')) return false;
  res.status(error.status || 409).json({ message: error.message, code: error.code, details: error.details || null });
  return true;
}

module.exports = { withCalendarMutation, uncoveredPhases, sendCalendarMutationError, assertDoctorIdentityMutable };
