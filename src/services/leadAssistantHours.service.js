'use strict';
const { fn, col, literal } = require('sequelize');
const { parseConfiguration } = require('../lib/clinic-configuration');
const { normalizeGoogleOpeningHours } = require('../lib/webArtifactCompiler');
const { normalizeScheduleRows } = require('./clinicOpeningHours.service');
const { resolveBusinessLocationForClinic } = require('./webArtifacts.service');

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Opening hours come from local records. They never stand for available
// appointments, reception staffing or an emergency handoff destination.
async function readOpeningHours(db, clinic, transaction) {
  const location = await resolveBusinessLocationForClinic(clinic, {
    models: db, transaction,
    attributes: ['id', 'clinica_id', [fn('JSON_EXTRACT', col('raw_payload'), literal("'$.regularHours'")), 'regularHours']],
  });
  const row = location?.get ? location.get({ plain: true }) : location;
  if (row && Number(row.clinica_id) === Number(clinic.id_clinica)) {
    const periods = normalizeGoogleOpeningHours(parseConfiguration(row.regularHours));
    const hours = periods.map(period => ({
      weekday: days.indexOf(period.dayOfWeek.split('/').pop()), opens: period.opens, closes: period.closes,
    }));
    if (hours.length) return { source: 'business_profile', hours };
  }
  const internal = await db.ClinicaHorario.findAll({
    where: { clinica_id: clinic.id_clinica, activo: true }, attributes: ['dia_semana', 'hora_inicio', 'hora_fin', 'activo'], raw: true, transaction,
  });
  const hours = normalizeScheduleRows(internal).map(({weekday, start, end}) => ({weekday, opens: start, closes: end}));
  return { source: hours.length ? 'clinic_schedule' : null, hours };
}
module.exports = { readOpeningHours };
