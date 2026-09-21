'use strict';

const { bookingCapabilities } = require('./treatmentBookingProfile.service');
const { resolveInstallationKeys, permitsLegacyOverlap, protectedBookingAttribute } = require('./appointmentBookingAvailability.service');

/** One bounded resource read for old availability screens and schedule impact.
 * A segmented appointment occupies each resource only for its actual phase.
 * Never return patient/clinical fields or use the primary projection as a second
 * reservation. With gates off the old schema remains readable.
 */
async function resourceAppointments({ db, clinic = null, doctorId = null, installationId = null, doctorIds = [], installationIds = [],
  start, end, ignoreAppointmentId = null, transaction = null, enabled = bookingCapabilities().simple }) {
  const doctors = [...new Set([...doctorIds, ...(doctorId ? [doctorId] : [])].map(Number))];
  const installations = [...new Set([...installationIds, ...(installationId ? [installationId] : [])].map(Number))];
  if (!doctors.length && !installations.length) throw Error('RESOURCE_CALENDAR_RANGE_INVALID');
  if (doctors.length + installations.length > 101 || [...doctors, ...installations].some(id => !Number.isSafeInteger(id) || id < 1)) throw Error('RESOURCE_CALENDAR_SCOPE_INVALID');
  if (!Number.isFinite(new Date(start).getTime()) || !Number.isFinite(new Date(end).getTime()) || new Date(end) <= new Date(start)
    || new Date(end) - new Date(start) > 367 * 86400000) throw Error('RESOURCE_CALENDAR_RANGE_INVALID');
  const { Op } = db.Sequelize;
  let physicalIds = installations;
  let mapping = null;
  let keys = [];
  if (installations.length) {
    if (!clinic) throw Error('RESOURCE_CALENDAR_CLINIC_REQUIRED');
    mapping = await resolveInstallationKeys({ db, clinic, installationIds: installations, transaction, enabled });
    physicalIds = mapping.physicalInstallationIds;
    keys.push(...installations.map(id => mapping.keys.get(id)));
  }
  keys.push(...doctors.map(id => `doctor:${id}`));
  const legacy = await db.CitaPaciente.findAll({ where: { estado: { [Op.ne]: 'cancelada' },
    inicio: { [Op.lt]: end }, fin: { [Op.gt]: start },
    ...(ignoreAppointmentId ? { id_cita: { [Op.ne]: ignoreAppointmentId } } : {}),
    [Op.or]: [...(doctors.length ? [{ doctor_id: { [Op.in]: doctors } }] : []), ...(physicalIds.length ? [{ instalacion_id: { [Op.in]: physicalIds } }] : [])],
  }, attributes: ['id_cita', 'clinica_id', 'doctor_id', 'instalacion_id', 'inicio', 'fin',
    ...(enabled ? ['source_system', protectedBookingAttribute(db, 'CitaPaciente')] : [])], transaction, raw: true });
  if (!enabled) return legacy;
  const occupancy = await db.AppointmentBookingOccupancy.findAll({ where: {
    ...(ignoreAppointmentId ? { appointment_id: { [Op.ne]: ignoreAppointmentId } } : {}),
    [Op.or]: [
      { resource_key: { [Op.in]: keys }, start_at: { [Op.lt]: end }, end_at: { [Op.gt]: start } },
      ...(legacy.length ? [{ appointment_id: { [Op.in]: legacy.map(r => r.id_cita) } }] : []),
    ],
  }, include: [{ model: db.CitaPaciente, as: 'appointment', required: true,
    attributes: ['id_cita', 'clinica_id', 'source_system', protectedBookingAttribute(db, 'appointment')], where: { estado: { [Op.ne]: 'cancelada' } } }], transaction });
  const segmented = new Set(occupancy.map(r => Number(r.appointment_id)));
  const project = row => {
    const targets = row.instalacion_id && mapping ? installations.filter(id => mapping.keys.get(id) === mapping.keys.get(Number(row.instalacion_id))) : [];
    return targets.length ? targets.map(id => ({ ...row, instalacion_id: id })) : [row];
  };
  const result = legacy.filter(r => !segmented.has(Number(r.id_cita))).flatMap(row => {
    const { source_system, booking_protected, ...safe } = row;
    return project({ ...safe, can_force_legacy: permitsLegacyOverlap(row, row.clinica_id) });
  });
  const seen = new Set();
  for (const row of occupancy) {
    if (!keys.includes(row.resource_key) || new Date(row.start_at) >= new Date(end) || new Date(row.end_at) <= new Date(start)) continue;
    const key = `${row.appointment_id}:${row.resource_key}:${new Date(row.start_at).toISOString()}:${new Date(row.end_at).toISOString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(...project({ id_cita: Number(row.appointment_id), clinica_id: Number(row.appointment.clinica_id),
      doctor_id: row.doctor_id, instalacion_id: row.installation_id, inicio: row.start_at, fin: row.end_at, segmented: true,
      can_force_legacy: permitsLegacyOverlap(row.appointment, row.appointment.clinica_id) }));
  }
  return result;
}

async function resourceInstallationBlocks({ db, clinic, installationIds, start, end, transaction = null,
  enabled = bookingCapabilities().simple }) {
  const mapping = await resolveInstallationKeys({ db, clinic, installationIds, transaction, enabled });
  const { Op } = db.Sequelize;
  const rows = await db.InstalacionBloqueo.findAll({ where: { instalacion_id: { [Op.in]: mapping.physicalInstallationIds },
    fecha_inicio: { [Op.lt]: end }, fecha_fin: { [Op.gt]: start } },
    attributes: ['id', 'instalacion_id', 'fecha_inicio', 'fecha_fin', 'motivo'], transaction, raw: true });
  return rows.flatMap(row => installationIds.filter(id => mapping.keys.get(id) === mapping.keys.get(Number(row.instalacion_id)))
    .map(id => ({ ...row, instalacion_id: id,
      ...(id !== Number(row.instalacion_id) ? { id: null, motivo: 'Instalación no disponible' } : {}),
    })));
}

module.exports = { resourceAppointments, resourceInstallationBlocks };
