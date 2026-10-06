'use strict';

const { resourceAppointments, resourceInstallationBlocks } = require('../services/appointmentResourceCalendar.service');
const { loadBookingContext } = require('../services/appointmentBookingAvailability.service');
const { installationAllowsStaff } = require('./installation-professionals');
const { addDays } = require('./personal-schedule-recurring');
const { projectPersonalBlocks } = require('./agenda-personal-blocks');
const {
  resolveClinicTimezone, localDateTimeToUtc, formatLocal, buildWindowsFromHorarios,
  buildDoctorBloqueoRowsForDate, buildDoctorAvailabilityContext, hasActiveSchedule,
} = require('./availability-calendar');

const uniqueIds = values => [...new Set((values || []).map(Number))];
const groupBy = (rows, field) => {
  const result = new Map();
  for (const row of rows || []) {
    const key = Number(row[field]);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(row);
  }
  return result;
};
const intersects = (start, end, a, b) => new Date(a) < end && new Date(b) > start;
const intersectWindows = (a, b) => (a || []).flatMap(w => (b || []).map(d => ({
  start: new Date(Math.max(w.start, d.start)), end: new Date(Math.min(w.end, d.end)),
}))).filter(w => w.start < w.end);
const subtractIntervals = (windows, blocks) => {
  let result = [...windows];
  for (const block of blocks) result = result.flatMap(window => {
    if (!(window.start < block.end && block.start < window.end)) return [window];
    return [window.start < block.start ? { start: window.start, end: block.start } : null,
      block.end < window.end ? { start: block.end, end: window.end } : null].filter(Boolean);
  });
  return result.filter(w => w.start < w.end);
};

/** The legacy slot calculation, shared by /slots and the range snapshot.
 * Keep the legacy alignment at each free interval's start; do not reinterpret
 * a historical visit using today's treatment duration or clinical profile.
 */
function buildLegacySlots({ baseStart, baseEnd, clinicHasSchedule, clinicWins, inst, instWins,
  doctorCtx, additionalStaffIds = [], supportContext, timeZone, durMin, stepMin, maxSlots,
  instBlocksRows = [], instCitasRows = [], docBlocksRows = [], docCitasRows = [] }) {
  const flexible = doctorCtx?.agendaFlexible === true;
  if (inst && !installationAllowsStaff(inst, [flexible ? null : doctorCtx?.doctorId, ...additionalStaffIds].filter(Boolean))
    && (!flexible || additionalStaffIds.length)) return [];
  let windows = [{ start: baseStart, end: baseEnd }];
  if (clinicHasSchedule && !flexible) windows = intersectWindows(windows, clinicWins);
  if (inst && !flexible) windows = intersectWindows(windows, instWins);
  if (doctorCtx?.dcMissing) windows = [];
  else if (!flexible && Array.isArray(doctorCtx?.docWins)) windows = intersectWindows(windows, doctorCtx.docWins);
  const blocks = [];
  for (const id of additionalStaffIds) {
    const person = supportContext?.doctors.get(id);
    windows = intersectWindows(windows, person?.windows || []);
    blocks.push(...(person?.busy || []).map(row => ({ start: new Date(row.start), end: new Date(row.end) })));
  }
  for (const row of [...instBlocksRows, ...docBlocksRows]) blocks.push({ start: new Date(row.fecha_inicio), end: new Date(row.fecha_fin) });
  if (!flexible) for (const row of [...instCitasRows, ...docCitasRows]) blocks.push({ start: new Date(row.inicio), end: new Date(row.fin) });
  const slots = [];
  for (const window of subtractIntervals(windows, blocks)) {
    for (let cursor = window.start.getTime(); cursor + durMin * 60000 <= window.end.getTime(); cursor += stepMin * 60000) {
      const start = new Date(cursor), end = new Date(cursor + durMin * 60000);
      slots.push({ start_local: formatLocal(start, timeZone), end_local: formatLocal(end, timeZone),
        start_utc: start.toISOString(), end_utc: end.toISOString() });
      if (slots.length >= maxSlots) return slots;
    }
  }
  return slots;
}

/** SQL is bounded by the resource/range footprint, not dates × columns.
 * A snapshot exists only inside one authenticated request. Next request reads
 * fresh DB state, including other-clinic staff, shared rooms and segmented
 * equipment/partial-staff occupancy through the existing canonical readers.
 * Separate doctor/room projections avoid turning a room phase into full staff
 * attention, or projecting an alias room's doctor onto the selected clinician.
 */
async function loadLegacyAvailabilitySnapshot({ db, clinic, dates, doctorIds = [], installationIds = [],
  additionalStaffIds = [], fetchClinicHorarios, readers = {} }) {
  const doctors = uniqueIds(doctorIds), installations = uniqueIds(installationIds);
  if (doctors.length > 100 || installations.length > 100
    || [...doctors, ...installations].some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw Object.assign(Error('Rango o recursos de disponibilidad inválidos'), { statusCode: 400 });
  }
  const sortedDates = [...new Set(dates)].sort(), timeZone = resolveClinicTimezone(clinic);
  const start = localDateTimeToUtc(sortedDates[0], '00:00:00', timeZone);
  const end = localDateTimeToUtc(addDays(sortedDates[sortedDates.length - 1], 1), '00:00:00', timeZone);
  if (!start || !end || end <= start || end - start > 367 * 86400000) {
    throw Object.assign(Error('Rango de disponibilidad inválido'), { statusCode: 400 });
  }
  const clinicId = Number(clinic.id_clinica), { Op } = db.Sequelize;
  const appointmentsReader = readers.resourceAppointments || resourceAppointments;
  const blocksReader = readers.resourceInstallationBlocks || resourceInstallationBlocks;
  const supportReader = readers.loadBookingContext || loadBookingContext;
  // Authorize installation ownership/activity before consulting shared-room
  // aliases/occupancy. Invalid columns remain per-column errors, not a source
  // of another clinic's resource metadata.
  const installationsRows = (installations.length ? await db.Instalacion.findAll({
    where: { id: { [Op.in]: installations }, clinica_id: clinicId, activo: true },
    include: [{ model: db.InstalacionHorario, as: 'horarios' }],
  }) : []).filter(row => installations.includes(Number(row.id)) && Number(row.clinica_id) === clinicId && (row.activo === true || row.activo === 1));
  const validInstallations = installationsRows.map(row => Number(row.id));
  const doctorRows = (doctors.length ? await db.DoctorClinica.findAll({
    where: { doctor_id: { [Op.in]: doctors }, clinica_id: clinicId, activo: true },
    include: [{ model: db.DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] }],
  }) : []).filter(row => doctors.includes(Number(row.doctor_id)) && Number(row.clinica_id) === clinicId && (row.activo === true || row.activo === 1));
  const validDoctors = doctorRows.map(row => Number(row.doctor_id));
  const [clinicHorarios, doctorBlockDefs, installationBlocks, installationAppointments,
    doctorAppointments, supportContext] = await Promise.all([
    fetchClinicHorarios(clinicId),
    validDoctors.length ? db.DoctorBloqueo.findAll({ where: { doctor_id: { [Op.in]: validDoctors }, [Op.or]: [
      { recurrente: 'none', fecha_inicio: { [Op.lt]: end }, fecha_fin: { [Op.gt]: start } },
      { recurrente: { [Op.ne]: 'none' }, fecha_inicio: { [Op.lte]: end } },
    ] }, attributes: ['id', 'doctor_id', 'fecha_inicio', 'fecha_fin', 'motivo', 'tipo', 'clinica_id', 'recurrente', 'aplica_a_todas_clinicas'],
    include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }] }) : [],
    validInstallations.length ? blocksReader({ db, clinic, installationIds: validInstallations, start, end }) : [],
    validInstallations.length ? appointmentsReader({ db, clinic, installationIds: validInstallations, start, end }) : [],
    validDoctors.length ? appointmentsReader({ db, doctorIds: validDoctors, start, end }) : [],
    additionalStaffIds.length ? supportReader({ db, clinic, profile: { phases: [] }, start, end, dates: sortedDates,
      additionalStaffIds, occupancyEnabled: true, includeDiagnosticLabels: true }) : null,
  ]);
  const installationMap = new Map(installationsRows.map(row => [Number(row.id), row]));
  const doctorMap = new Map(doctorRows.map(row => [Number(row.doctor_id), row]));
  const days = new Map();
  return { clinic, timeZone, installationMap, doctorMap, additionalStaffIds, supportContext,
    personalBlocks: projectPersonalBlocks(doctorBlockDefs.filter(row => validDoctors.includes(Number(row.doctor_id))
      && (row.clinica_id == null || Number(row.clinica_id) === clinicId || row.aplica_a_todas_clinicas === true || row.aplica_a_todas_clinicas === 1)), sortedDates, timeZone),
    day(date) {
      if (days.has(date)) return days.get(date);
      if (!sortedDates.includes(date)) throw Error('AVAILABILITY_SNAPSHOT_DATE_OUT_OF_SCOPE');
      const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
      const dayStart = localDateTimeToUtc(date, '00:00:00', timeZone);
      const dayEnd = localDateTimeToUtc(addDays(date, 1), '00:00:00', timeZone);
      const result = { dow, clinicHasSchedule: hasActiveSchedule(clinicHorarios),
        clinicWins: buildWindowsFromHorarios(clinicHorarios, dow, date, timeZone),
        installationWindows: new Map(installationsRows.map(inst => [Number(inst.id), buildWindowsFromHorarios(inst.horarios || [], dow, date, timeZone)])),
        doctorContexts: new Map(doctors.map(id => [id, buildDoctorAvailabilityContext({ doctorId: id, clinicaId: clinicId,
          dc: doctorMap.get(id) || null, dow, fechaLocal: date, timeZone })])),
        installationBlocks: groupBy(installationBlocks.filter(row => intersects(dayStart, dayEnd, row.fecha_inicio, row.fecha_fin)), 'instalacion_id'),
        installationAppointments: groupBy(installationAppointments.filter(row => intersects(dayStart, dayEnd, row.inicio, row.fin)), 'instalacion_id'),
        doctorBlocks: groupBy(buildDoctorBloqueoRowsForDate(doctorBlockDefs, date, timeZone), 'doctor_id'),
        doctorAppointments: groupBy(doctorAppointments.filter(row => intersects(dayStart, dayEnd, row.inicio, row.fin)), 'doctor_id'),
      };
      days.set(date, result);
      return result;
    },
  };
}

module.exports = { buildLegacySlots, loadLegacyAvailabilitySnapshot };
