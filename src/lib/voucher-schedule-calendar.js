'use strict';

const { addDays } = require('./personal-schedule-recurring');
const {
  formatPartsInTimeZone,
  formatDateLocal,
  offsetMinutesForTimeZone,
} = require('./availability-calendar');

function scheduleError(code, message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
}

// The ordinary agenda accepts instants; a recurring series additionally needs
// an unambiguous wall-clock time on every future local date. Do not silently
// shift a nonexistent 02:30 or select one of two 02:30 occurrences at DST.
function resolveLocalInstant(date, time, timeZone) {
  const value = `${date}T${time}`;
  const naive = new Date(`${value}Z`);
  if (!Number.isFinite(naive.getTime())) {
    throw scheduleError('voucher_schedule_start_invalid', 'La fecha de la cita no es válida.');
  }
  const offsets = new Set([-1, 0, 1].map((delta) => {
    const probe = new Date(naive);
    probe.setUTCDate(probe.getUTCDate() + delta);
    return offsetMinutesForTimeZone(probe, timeZone);
  }));
  const matches = [...offsets].map((offset) => new Date(naive.getTime() - offset * 60000))
    .filter((candidate) => {
      const parts = formatPartsInTimeZone(candidate, timeZone);
      const pad = (part) => String(part).padStart(2, '0');
      return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}` === value;
    });
  if (matches.length !== 1) {
    throw scheduleError('voucher_schedule_dst_conflict', 'Una cita coincide con una hora inexistente o ambigua por el cambio horario. Elige otra hora.');
  }
  return matches[0];
}

function parseSeriesStart(value, timeZone) {
  if (typeof value !== 'string') {
    throw scheduleError('voucher_schedule_start_invalid', 'Elige una primera cita futura.');
  }
  const local = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/);
  const start = local
    ? resolveLocalInstant(local[1], `${local[2]}:${local[3] || '00'}`, timeZone)
    : (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? new Date(value) : null);
  if (!start || !Number.isFinite(start.getTime())) {
    throw scheduleError('voucher_schedule_start_invalid', 'La fecha de la primera cita no es válida.');
  }
  return start;
}

function buildSeriesSlots({ startAt, count, intervalDays, durationMinutes, timeZone }) {
  const firstDate = formatDateLocal(startAt, timeZone);
  const parts = formatPartsInTimeZone(startAt, timeZone);
  const time = [parts.hour, parts.minute, parts.second].map((part) => String(part).padStart(2, '0')).join(':');
  return Array.from({ length: count }, (_, index) => {
    const date = addDays(firstDate, index * intervalDays);
    const start = index === 0 ? new Date(startAt) : resolveLocalInstant(date, time, timeZone);
    const end = new Date(start.getTime() + durationMinutes * 60000);
    return { sequence: index + 1, start, end };
  });
}

module.exports = { parseSeriesStart, buildSeriesSlots, resolveLocalInstant };
