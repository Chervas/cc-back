'use strict';

// A mapped date means performed care, never merely a date found in a row.
const CARE_DATE_IMPORT_ALIASES = Object.freeze([
  'fecha_ultima_cita_asistida', 'ultima_cita_asistida',
  'fecha_ultima_atencion', 'ultima_atencion', 'fecha_atencion', 'fecha_de_atencion', 'fecha_atencion_realizada',
  'fecha_tratamiento', 'fecha_de_tratamiento', 'fecha_tratamiento_realizado', 'fecha_ultimo_tratamiento',
  'fecha_realizacion', 'fecha_realizacion_tratamiento', 'fecha_fin_realizacion', 'fecha_fin_tratamiento',
  'fecha_ultima_visita', 'ultima_visita', 'last_visit', 'last_visit_at', 'last_attended_appointment_date',
  'care_completed_at',
]);
const MONTHS = Object.freeze({ ene: 1, enero: 1, feb: 2, febrero: 2, mar: 3, marzo: 3, abr: 4, abril: 4,
  may: 5, mayo: 5, jun: 6, junio: 6, jul: 7, julio: 7, ago: 8, agosto: 8, sep: 9, sept: 9,
  septiembre: 9, setiembre: 9, oct: 10, octubre: 10, nov: 11, noviembre: 11, dic: 12, diciembre: 12 });

function normalizeCareDateHeader(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function inferCareDateColumn(headers = [], explicit = {}) {
  if (Object.prototype.hasOwnProperty.call(explicit, 'last_visit_at')) return explicit.last_visit_at || null;
  const byKey = new Map(headers.map(header => [normalizeCareDateHeader(header), header]));
  for (const alias of CARE_DATE_IMPORT_ALIASES) if (byKey.has(alias)) return byKey.get(alias);
  return null;
}

function dayKey(year, month, day) {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
}

function parseImportedCareDate(value, { format = 'dmy', excelDateSystem = '1900', now = new Date() } = {}) {
  const result = (status, date = null, reason = status) => ({ status, date,
    formatted: date ? `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}` : '', reason });
  if (value === null || value === undefined || value === '') return result('missing');
  if (!['dmy', 'mdy'].includes(format) || !['1900', '1904'].includes(excelDateSystem)) {
    return result('invalid', null, 'unsupported_format');
  }
  let date = null;
  if (value instanceof Date) {
    if (Number.isFinite(value.getTime())) date = dayKey(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  } else if (typeof value === 'number' || /^\d{5,7}(?:\.\d+)?$/.test(String(value).trim())) {
    const serial = Number(value);
    const day = Math.floor(serial);
    if (Number.isFinite(serial) && serial >= (excelDateSystem === '1904' ? 0 : 1) && day <= 2958465
      && !(excelDateSystem === '1900' && day === 60)) {
      const epoch = excelDateSystem === '1904' ? Date.UTC(1904, 0, 1)
        : Date.UTC(1899, 11, day < 60 ? 31 : 30);
      const parsed = new Date(epoch + day * 86400000);
      date = dayKey(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
    }
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return result('missing');
    const tail = '(?:[ T]((?:[01]\\d|2[0-3])):([0-5]\\d)(?::([0-5]\\d)(?:\\.\\d{1,9})?)?(?:Z|[+-](?:[01]\\d|2[0-3]):?[0-5]\\d)?)?';
    let match = text.match(new RegExp('^(\\d{4})-(\\d{2})-(\\d{2})' + tail + '$'));
    if (match) {
      if ((!match[4] || +match[4] < 24) && (!match[5] || +match[5] < 60) && (!match[6] || +match[6] < 60)) {
        date = dayKey(+match[1], +match[2], +match[3]);
      }
    } else {
      match = text.match(new RegExp('^(\\d{1,2})[/.\\-](\\d{1,2})[/.\\-](\\d{4})' + tail + '$'));
      if (match) {
        if ((!match[4] || +match[4] < 24) && (!match[5] || +match[5] < 60) && (!match[6] || +match[6] < 60)) {
          const year = +match[3];
          date = dayKey(year, format === 'mdy' ? +match[1] : +match[2], format === 'mdy' ? +match[2] : +match[1]);
        }
      } else {
        match = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
          .match(new RegExp('^(\\d{1,2})\\s+(?:de\\s+)?([a-z]+)\\s+(?:de\\s+)?(\\d{4})' + tail + '$', 'i'));
        if (match && MONTHS[match[2]]) date = dayKey(+match[3], MONTHS[match[2]], +match[1]);
      }
    }
  }
  if (!date) return result('invalid');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return date > today ? result('future', date) : result('valid', date);
}

function readImportedCareDate(row = {}, mapping = {}, body = {}, now) {
  const column = inferCareDateColumn(Object.keys(row), mapping);
  if (!column) return { status: 'unmapped', date: null, formatted: '', reason: 'unmapped' };
  if (/(^|_)(nacimiento|nac|birth|birthday|dob|pago|pagos|payment|paid|cobro|cobros|factura|vencimiento|expiracion|futura|futuras|futuro|proxima|proximo|next|scheduled)(_|$)/.test(normalizeCareDateHeader(column))) {
    return { status: 'invalid', date: null, formatted: '', reason: 'not_care_date' };
  }
  return parseImportedCareDate(row[column], { format: body.import_date_format || 'dmy',
    excelDateSystem: body.import_excel_date_system || '1900', ...(now ? { now } : {}) });
}

module.exports = { CARE_DATE_IMPORT_ALIASES, normalizeCareDateHeader, inferCareDateColumn,
  parseImportedCareDate, readImportedCareDate };
