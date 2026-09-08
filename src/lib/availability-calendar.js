'use strict';

// Shared calendar semantics used by the public availability API and voucher series.
const { buildHorarioExceptionMap, expandHorariosForDate } = require('./personal-schedule-recurring');
const DEFAULT_TIMEZONE = 'Europe/Madrid';
const timeZoneFormatters = new Map();
const dayIndexFromLocalDate = (value) => new Date(`${value}T12:00:00Z`).getUTCDay();

const parseClinicConfig = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      return null;
    }
  }
  return null;
};

const isValidTimeZone = (value) => {
  if (!value || typeof value !== 'string') return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch (err) {
    return false;
  }
};

const resolveClinicTimezone = (clinica) => {
  const cfg = parseClinicConfig(clinica && clinica.configuracion);
  const candidates = [
    cfg && (cfg.timezone || cfg.timeZone || cfg.tz),
    clinica && (clinica.timezone || clinica.time_zone || clinica.tz)
  ];

  for (const candidate of candidates) {
    if (isValidTimeZone(candidate)) return candidate;
  }
  return DEFAULT_TIMEZONE;
};

const formatPartsInTimeZone = (date, timeZone) => {
  let formatter = timeZoneFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
    });
    if (timeZoneFormatters.size >= 32) timeZoneFormatters.delete(timeZoneFormatters.keys().next().value);
    timeZoneFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(date);

  const bag = {};
  parts.forEach((p) => {
    if (p.type !== 'literal') bag[p.type] = p.value;
  });

  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour) === 24 ? 0 : Number(bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second)
  };
};

const offsetMinutesForTimeZone = (date, timeZone) => {
  const p = formatPartsInTimeZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
};

const normalizeHms = (value, fallback = '00:00:00') => {
  const raw = String(value || fallback).trim();
  const m = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return `${m[1]}:${m[2]}:${m[3] || '00'}`;
};

const localDateTimeToUtc = (fechaLocal, timeValue, timeZone) => {
  if (!fechaLocal || typeof fechaLocal !== 'string') return null;
  const d = fechaLocal.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!d) return null;

  const hms = normalizeHms(timeValue);
  if (!hms) return null;
  const t = hms.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!t) return null;

  const year = Number(d[1]);
  const month = Number(d[2]);
  const day = Number(d[3]);
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  const second = Number(t[3]);

  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let ts = naiveUtc;

  // Dos iteraciones son suficientes para converger en cambios de DST.
  for (let i = 0; i < 2; i++) {
    const offsetMin = offsetMinutesForTimeZone(new Date(ts), timeZone);
    ts = naiveUtc - offsetMin * 60000;
  }

  return new Date(ts);
};

const formatDateLocal = (date, timeZone) => {
  const p = formatPartsInTimeZone(date, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

const parseDateTime = (value, timeZone) => {
  if (!value || typeof value !== 'string') return null;

  // Con timezone explícita (Z o +/-hh:mm)
  if (/[Zz]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // "YYYY-MM-DDTHH:mm" o "YYYY-MM-DDTHH:mm:ss" sin timezone -> hora local de la clínica.
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)$/);
  if (m) {
    return localDateTimeToUtc(m[1], m[2], timeZone);
  }

  // Fallback: intentar parse nativo
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const formatLocal = (date, timeZone) => {
  const p = formatPartsInTimeZone(date, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
};

const buildWindowsFromHorarios = (horarios, dow, fechaLocal, timeZone) => {
  const exceptionMap = buildHorarioExceptionMap(
    (horarios || []).flatMap((h) => Array.isArray(h?.excepciones) ? h.excepciones : [])
  );
  const expanded = expandHorariosForDate(horarios || [], fechaLocal, exceptionMap)
    .filter((h) => h.dia_semana === dow && h.activo);
  const base = expanded
    .map((h) => {
      const start = localDateTimeToUtc(fechaLocal, h.hora_inicio, timeZone);
      const end = localDateTimeToUtc(fechaLocal, h.hora_fin, timeZone);
      return { start, end };
    })
    .filter((w) => w.start && w.end && Number.isFinite(w.start.getTime()) && Number.isFinite(w.end.getTime()) && w.start < w.end);
  return base;
};

const buildDoctorBloqueoRowsForDate = (bloqueos, fechaLocal, timeZone) => {
  const targetDow = dayIndexFromLocalDate(fechaLocal);
  return (bloqueos || []).flatMap((bloqueo) => {
    const exceptions = Array.isArray(bloqueo?.excepciones) ? bloqueo.excepciones : [];
    const canceled = exceptions.some((row) => String(row?.fecha || '') === fechaLocal && row?.cancelado !== false);
    if (canceled) return [];

    const startDay = formatDateLocal(bloqueo.fecha_inicio, timeZone);
    const endDay = formatDateLocal(bloqueo.fecha_fin, timeZone);
    const startParts = formatPartsInTimeZone(bloqueo.fecha_inicio, timeZone);
    const endParts = formatPartsInTimeZone(bloqueo.fecha_fin, timeZone);
    const startHm = `${String(startParts.hour).padStart(2, '0')}:${String(startParts.minute).padStart(2, '0')}`;
    const endHm = `${String(endParts.hour).padStart(2, '0')}:${String(endParts.minute).padStart(2, '0')}`;
    const recurrente = String(bloqueo.recurrente || 'none');

    let applies = false;
    if (recurrente === 'none') {
      applies = fechaLocal >= startDay && fechaLocal <= endDay;
    } else if (recurrente === 'daily') {
      applies = fechaLocal >= startDay;
    } else if (recurrente === 'weekly') {
      applies = fechaLocal >= startDay && targetDow === dayIndexFromLocalDate(startDay);
    } else if (recurrente === 'monthly') {
      applies = fechaLocal >= startDay && Number(fechaLocal.slice(8, 10)) === Number(startDay.slice(8, 10));
    }
    if (!applies) return [];

    const occStartHm = recurrente === 'none'
      ? (fechaLocal === startDay ? startHm : '00:00')
      : startHm;
    const occEndHm = recurrente === 'none'
      ? (fechaLocal === endDay ? endHm : '23:59')
      : endHm;
    const start = localDateTimeToUtc(fechaLocal, occStartHm, timeZone);
    const end = localDateTimeToUtc(fechaLocal, occEndHm, timeZone);
    if (!start || !end || start >= end) return [];

    return [{
      ...bloqueo.toJSON?.() || bloqueo,
      fecha_inicio: start,
      fecha_fin: end,
    }];
  });
};

const hasActiveSchedule = (horarios) => {
  return Array.isArray(horarios) && horarios.some((h) => !!h.activo);
};

const normalizeRecibeCitas = (value) => {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'si', 'sí', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return false;
};

const mergeWindows = (windows) => {
  const sorted = (windows || [])
    .filter((w) => w?.start && w?.end && w.start < w.end)
    .sort((a, b) => a.start - b.start);

  if (!sorted.length) return [];

  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i];
    const last = merged[merged.length - 1];
    if (curr.start <= last.end) {
      last.end = new Date(Math.max(last.end.getTime(), curr.end.getTime()));
      continue;
    }
    merged.push({ start: curr.start, end: curr.end });
  }
  return merged;
};

const buildDoctorAvailabilityContext = ({
  doctorId,
  clinicaId,
  dc,
  dow,
  fechaLocal,
  timeZone
}) => {
  if (!doctorId) {
      return {
        docWins: [],
        dcMissing: false,
        outOfHoursMessage: 'Doctor fuera de horario'
      };
    }

  if (dc === null) {
      return {
        docWins: [],
        dcMissing: true,
        outOfHoursMessage: 'Doctor no asignado a la clínica'
      };
    }

  const receiveAppointments = normalizeRecibeCitas(dc?.recibe_citas);
  const clinicWins = buildWindowsFromHorarios(dc?.horarios || [], dow, fechaLocal, timeZone);

  if (!receiveAppointments) {
    return {
      docWins: [],
      dcMissing: false,
      outOfHoursMessage: 'Profesional en modo sin citas (no aparece en agenda de citas)'
    };
  }

  const message = clinicWins.length
    ? 'Profesional fuera de su horario en esta clínica'
    : 'Profesional sin horario configurado en esta clínica';

  return {
    docWins: mergeWindows(clinicWins),
    dcMissing: false,
    outOfHoursMessage: message
  };
};

const inAnyWindow = (windows, start, end) => {
  if (!Array.isArray(windows) || windows.length === 0) return false;
  return windows.some((w) => start >= w.start && end <= w.end);
};

module.exports = {
  parseClinicConfig,
  isValidTimeZone,
  resolveClinicTimezone,
  formatPartsInTimeZone,
  offsetMinutesForTimeZone,
  normalizeHms,
  localDateTimeToUtc,
  formatDateLocal,
  parseDateTime,
  formatLocal,
  buildWindowsFromHorarios,
  buildDoctorBloqueoRowsForDate,
  hasActiveSchedule,
  normalizeRecibeCitas,
  mergeWindows,
  buildDoctorAvailabilityContext,
  inAnyWindow,
  dayIndexFromLocalDate,
};
