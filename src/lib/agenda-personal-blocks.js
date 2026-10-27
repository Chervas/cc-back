'use strict';
const { buildDoctorBloqueoRowsForDate, formatLocal, localDateTimeToUtc } = require('./availability-calendar');
const { addDays } = require('./personal-schedule-recurring');
const { loadPersonalBlockScopes } = require('./personal-block-scope');

// Real block occurrences, not the complement of treatment start availability.
// Preserve each definition's identity even when reasons or adjacent times match.
function redactPersonalBlockDetails(rows, clinicId, readableClinicIds = []) {
  const readable = new Set(readableClinicIds.map(Number));
  return rows.map(value => {
    const row = value.toJSON ? value.toJSON() : value;
    return clinicId != null && row.clinica_id != null && Number(row.clinica_id) !== Number(clinicId)
      && !readable.has(Number(row.clinica_id))
      ? { ...row, tipo: 'ausencia', motivo: '', motivo_redacted: true, can_edit: false } : row;
  });
}
function projectPersonalBlocks(definitions, dates, timezone, scopes = null, { clinicId = null, readableClinicIds = [] } = {}) {
  return dates.flatMap(day => redactPersonalBlockDetails(buildDoctorBloqueoRowsForDate(definitions, day, timezone), clinicId, readableClinicIds).map(row => {
    return {
    id: Number(row.id), doctor_id: Number(row.doctor_id), clinica_id: row.clinica_id == null ? null : Number(row.clinica_id),
    day_id: day, start_local: formatLocal(row.fecha_inicio, timezone), end_local: formatLocal(row.fecha_fin, timezone),
    tipo: row.tipo || 'otro', motivo: row.motivo || '', recurrente: row.recurrente || 'none',
    ...(row.motivo_redacted ? { motivo_redacted: true, can_edit: false } : {}),
    ...(scopes ? scopes.metadata(row) : {}),
    };
  }));
}

async function loadAgendaPersonalBlocks({ db, clinic, doctorIds, dates, timezone, readableBlockClinicIds = [] }) {
  const { Op } = db.Sequelize;
  const ids = [...new Set(doctorIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return [];
  // The caller has already authorized appointments.view for this clinic.
  // Never expose blocks of an arbitrary user passed as a peer/column ID.
  const links = await db.DoctorClinica.findAll({ where: { doctor_id: { [Op.in]: ids },
    clinica_id: Number(clinic), activo: true }, attributes: ['id', 'doctor_id', 'clinica_id', 'activo',
      ...(!db.DoctorClinica.rawAttributes || db.DoctorClinica.rawAttributes.shared_schedule_source_id ? ['shared_schedule_source_id'] : [])], raw: true });
  const allowed = [...new Set(links.map(row => Number(row.doctor_id)).filter(id => ids.includes(id)))];
  if (!allowed.length) return [];
  const ordered = [...dates].sort();
  const start = localDateTimeToUtc(ordered[0], '00:00:00', timezone);
  const end = localDateTimeToUtc(addDays(ordered[ordered.length - 1], 1), '00:00:00', timezone);
  const definitions = await db.DoctorBloqueo.findAll({ where: { doctor_id: { [Op.in]: allowed }, [Op.or]: [
    { recurrente: 'none', fecha_inicio: { [Op.lt]: end }, fecha_fin: { [Op.gt]: start } },
    { recurrente: { [Op.ne]: 'none' }, fecha_inicio: { [Op.lte]: end } },
  ] }, include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }] });
  const scopes = await loadPersonalBlockScopes({ db, doctorIds: allowed, links });
  return projectPersonalBlocks(scopes.filter(definitions.filter(row => allowed.includes(Number(row.doctor_id))), clinic), dates, timezone, scopes, { clinicId: clinic, readableClinicIds: readableBlockClinicIds });
}
module.exports = { projectPersonalBlocks, loadAgendaPersonalBlocks, redactPersonalBlockDetails };
