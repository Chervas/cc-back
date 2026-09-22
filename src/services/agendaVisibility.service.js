'use strict';
const { buildWindowsFromHorarios, dayIndexFromLocalDate, resolveClinicTimezone,
  buildDoctorBloqueoRowsForDate } = require('../lib/availability-calendar');
const { installationAllowsStaff } = require('../lib/installation-professionals');

function visibilityDates(value) {
  const dates = [...new Set(String(value || '').split(','))];
  if (!dates.length || dates.length > 14 || dates.some(date => !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) {
    const error = new Error('Indica entre 1 y 14 fechas válidas.');
    error.status = 400;
    throw error;
  }
  if (Math.max(...dates.map(Date.parse)) - Math.min(...dates.map(Date.parse)) > 31 * 86400000) {
    const error = new Error('Consulta como máximo un mes por solicitud.'); error.status = 400; throw error;
  }
  return dates.sort();
}

async function agendaVisibility({ db, clinicIds, dates }) {
  const { Op } = db.Sequelize;
  const [links, rooms, clinics] = await Promise.all([
    db.DoctorClinica.findAll({ where: { clinica_id: { [Op.in]: clinicIds }, activo: true, recibe_citas: true },
      include: [{ model: db.DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] }] }),
    db.Instalacion.findAll({ where: { clinica_id: { [Op.in]: clinicIds } },
      attributes: ['id', 'clinica_id', 'nombre', 'activo', 'profesionales_permitidos'] }),
    db.Clinica.findAll({ where: { id_clinica: { [Op.in]: clinicIds } }, attributes: ['id_clinica', 'configuracion'] }),
  ]);
  const ids = [...new Set(links.map(row => Number(row.doctor_id)))];
  const blocks = ids.length ? await db.DoctorBloqueo.findAll({ where: { doctor_id: { [Op.in]: ids },
    [Op.and]: [
      { [Op.or]: [{ clinica_id: { [Op.in]: clinicIds } }, { clinica_id: null }] },
      { [Op.or]: [{ recurrente: { [Op.ne]: 'none' } }, {
        fecha_inicio: { [Op.lt]: new Date(`${dates.at(-1)}T23:59:59Z`) },
        fecha_fin: { [Op.gt]: new Date(`${dates[0]}T00:00:00Z`) },
      }] },
    ] }, include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }] }) : [];
  return {
    dates,
    professionals: links.map(link => {
      const timeZone = resolveClinicTimezone(clinics.find(row => Number(row.id_clinica) === Number(link.clinica_id)));
      const ownBlocks = blocks.filter(row => Number(row.doctor_id) === Number(link.doctor_id)
        && (row.clinica_id == null || Number(row.clinica_id) === Number(link.clinica_id)));
      return { id: String(link.doctor_id), clinic_id: String(link.clinica_id),
        // Do not subtract appointments or absences: "has a shift" != "has a free slot".
        visible_dates: dates.filter(date => buildWindowsFromHorarios(link.horarios || [], dayIndexFromLocalDate(date), date, timeZone).length
          || buildDoctorBloqueoRowsForDate(ownBlocks, date, timeZone).length) };
    }),
    installations: rooms.map(room => ({ id: String(room.id), clinic_id: String(room.clinica_id),
      name: room.nombre, active: !!room.activo,
      professional_ids: links.filter(link => Number(link.clinica_id) === Number(room.clinica_id)
        && installationAllowsStaff(room, [link.doctor_id])).map(link => String(link.doctor_id)) })),
  };
}
module.exports = { visibilityDates, agendaVisibility };
