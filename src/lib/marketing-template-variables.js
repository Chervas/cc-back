'use strict';

const LAST_ATTENDED_DATE_KEYS = Object.freeze([
  'fecha_ultima_cita_asistida',
  'ultima_cita_asistida',
  'last_attended_appointment_date',
  'last_attended_visit_date',
  'fecha_ultima_cita',
  'fecha_ultimo_tratamiento',
  'fecha_tratamiento',
]);

const SPANISH_MONTHS = Object.freeze({
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
});

function clean(value) {
  return String(value ?? '').trim();
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month
    && date.getUTCDate() === day
    ? date
    : null;
}

function parseMarketingDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = clean(value);
  if (!raw) return null;

  let match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:\s|$)/);
  if (match) {
    const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    return validDateParts(year, Number(match[2]) - 1, Number(match[1]));
  }

  match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]|$)/);
  if (match) return validDateParts(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

  match = raw.toLowerCase().match(/^(\d{1,2})\s+de\s+([a-záéíóú]+)(?:\s+de)?\s+(\d{4})$/i);
  if (match) {
    const monthKey = match[2].normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const month = SPANISH_MONTHS[monthKey];
    if (month !== undefined) return validDateParts(Number(match[3]), month, Number(match[1]));
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatMarketingDate(value) {
  const date = parseMarketingDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function resolveLastAttendedAppointmentDate(item = {}) {
  const custom = item?.custom_fields && typeof item.custom_fields === 'object'
    ? item.custom_fields
    : {};
  const candidates = [
    ...LAST_ATTENDED_DATE_KEYS.map((key) => custom[key]),
    item.last_visit_at,
  ];
  for (const candidate of candidates) {
    const formatted = formatMarketingDate(candidate);
    if (formatted) return formatted;
  }
  return '';
}

module.exports = {
  LAST_ATTENDED_DATE_KEYS,
  formatMarketingDate,
  parseMarketingDate,
  resolveLastAttendedAppointmentDate,
};
