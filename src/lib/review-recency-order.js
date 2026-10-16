'use strict';

const CUSTOM_DATE_KEYS = ['fecha_fin_tratamiento','fecha_fin_realizacion','fecha_ultimo_tratamiento',
  'fecha_ultima_cita','fecha_ultima_cita_asistida','fecha_tratamiento','fecha_cita','fecha'];

function reviewRecencySql() {
  const dates = CUSTOM_DATE_KEYS.map(key => {
    const raw = `JSON_UNQUOTE(JSON_EXTRACT(custom_fields,'$.${key}'))`;
    return `CASE
      WHEN ${raw} REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN
        COALESCE(STR_TO_DATE(REPLACE(LEFT(${raw},19),'T',' '),'%Y-%m-%d %H:%i:%s'),STR_TO_DATE(LEFT(${raw},10),'%Y-%m-%d'))
      WHEN ${raw} REGEXP '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}' THEN
        COALESCE(STR_TO_DATE(${raw},'%d/%m/%Y %H:%i:%s'),STR_TO_DATE(${raw},'%d/%m/%Y'))
      WHEN ${raw} REGEXP '^[0-9]{1,2}-[0-9]{1,2}-[0-9]{4}' THEN
        COALESCE(STR_TO_DATE(${raw},'%d-%m-%Y %H:%i:%s'),STR_TO_DATE(${raw},'%d-%m-%Y')) END`;
  });
  return `COALESCE(last_visit_at,appointment_at,${dates.join(',')})`;
}

module.exports = { reviewRecencySql, CUSTOM_DATE_KEYS };
