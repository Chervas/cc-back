'use strict';

// Shared calendar semantics used by the public availability API and voucher series.
const { buildHorarioExceptionMap, expandHorariosForDate, addDays } = require('./personal-schedule-recurring');
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

// The nearest two anchors are enough: earlier occurrences end earlier and
// cannot extend the union on this date. This also handles long overlapping
// daily/monthly spans without iterating every day since the original block.
const bloqueoAnchorsForDate = (startDay, fechaLocal, recurrence) => {
  if (fechaLocal < startDay) return [];
  if (recurrence === 'daily') return [addDays(fechaLocal, -1), fechaLocal].filter(d => d >= startDay);
  if (recurrence === 'weekly') {
    const delta = (dayIndexFromLocalDate(fechaLocal) - dayIndexFromLocalDate(startDay) + 7) % 7;
    const latest = addDays(fechaLocal, -delta);
    return [addDays(latest, -7), latest].filter(d => d >= startDay);
  }
  if (recurrence !== 'monthly') return [];
  const day = Number(startDay.slice(8, 10)), anchors = [];
  const year = Number(fechaLocal.slice(0, 4)), month = Number(fechaLocal.slice(5, 7));
  for (let offset = 0; anchors.length < 2 && offset < 15; offset++) {
    const candidate = new Date(Date.UTC(year, month - 1 - offset, day));
    const monthStart = new Date(Date.UTC(year, month - 1 - offset, 1));
    if (candidate.getUTCMonth() !== monthStart.getUTCMonth()) continue;
    const date = candidate.toISOString().slice(0, 10);
    if (date > fechaLocal) continue;
    if (date < startDay) break;
    anchors.unshift(date);
  }
  return anchors;
};

const buildDoctorBloqueoRowsForDate = (bloqueos, fechaLocal, timeZone) => {
  const dayStart = localDateTimeToUtc(fechaLocal, '00:00', timeZone);
  const dayEnd = localDateTimeToUtc(addDays(fechaLocal, 1), '00:00', timeZone);
  if (!dayStart || !dayEnd) return [];
  return (bloqueos || []).flatMap((bloqueo) => {
    const exceptions = Array.isArray(bloqueo?.excepciones) ? bloqueo.excepciones : [];
    const exception = exceptions.filter(row => String(row?.fecha || '') === fechaLocal)
      .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
    // Block exceptions cancel the selected calendar date, including interior
    // dates of a recurring multi-day block.
    if (exception && exception.cancelado !== false) return [];
    const originalStart = new Date(bloqueo.fecha_inicio), originalEnd = new Date(bloqueo.fecha_fin);
    if (!Number.isFinite(originalStart.getTime()) || !Number.isFinite(originalEnd.getTime()) || originalStart >= originalEnd) return [];
    const startDay = formatDateLocal(originalStart, timeZone), endDay = formatDateLocal(originalEnd, timeZone);
    const startParts = formatPartsInTimeZone(originalStart, timeZone), endParts = formatPartsInTimeZone(originalEnd, timeZone);
    const hm = parts => `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    const recurrente = String(bloqueo.recurrente || 'none');
    const spanDays = Math.max(0, Math.round((new Date(`${endDay}T12:00:00Z`) - new Date(`${startDay}T12:00:00Z`)) / 86400000));
    const occurrences = recurrente === 'none' ? [{ start: originalStart, end: originalEnd }]
      : bloqueoAnchorsForDate(startDay, fechaLocal, recurrente).map(anchor => ({
        start: localDateTimeToUtc(anchor, hm(startParts), timeZone),
        end: localDateTimeToUtc(addDays(anchor, spanDays), hm(endParts), timeZone),
      }));
    const clipped = occurrences.map(({ start, end }) => ({
      start: new Date(Math.max(start?.getTime(), dayStart.getTime())),
      end: new Date(Math.min(end?.getTime(), dayEnd.getTime())),
    })).filter(({ start, end }) => Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start < end);
    return mergeWindows(clipped).map(({ start, end }) => ({
      ...bloqueo.toJSON?.() || bloqueo, fecha_inicio: start, fecha_fin: end,
    }));
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
    doctorId: Number(doctorId),
    agendaFlexible: require('./flexible-agenda').isFlexibleDoctor(dc),
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
