'use strict';

const db = require('../../models');

const DEFAULT_TIME_ZONE = 'Europe/Madrid';
const DEFAULT_NEXT_DAY_TIME = '09:00';

function cleanString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch (_error) {
    return false;
  }
}

function parseClinicConfig(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function resolveClinicTimeZone(clinic) {
  const config = parseClinicConfig(clinic?.configuracion);
  const candidates = [
    clinic?.timezone,
    clinic?.time_zone,
    config.timezone,
    config.timeZone,
    config.tz,
  ].map(cleanString).filter(Boolean);
  return candidates.find(isValidTimeZone) || DEFAULT_TIME_ZONE;
}

function partsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const bag = {};
  parts.forEach((part) => {
    if (part.type !== 'literal') bag[part.type] = part.value;
  });
  return Object.fromEntries(Object.entries(bag).map(([key, value]) => [key, Number(value)]));
}

function localDate(date, timeZone) {
  const parts = partsInTimeZone(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function addLocalDays(value, days) {
  const match = cleanString(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + Number(days || 0)));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function timeZoneOffsetMinutes(date, timeZone) {
  const parts = partsInTimeZone(date, timeZone);
  const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((representedAsUtc - date.getTime()) / 60000);
}

function localDateTimeToUtc(dateValue, timeValue, timeZone) {
  const dateMatch = cleanString(dateValue).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = cleanString(timeValue).match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch || !timeMatch) return null;
  const naiveUtc = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3] || 0)
  );
  let timestamp = naiveUtc;
  for (let index = 0; index < 2; index += 1) {
    timestamp = naiveUtc - (timeZoneOffsetMinutes(new Date(timestamp), timeZone) * 60000);
  }
  return new Date(timestamp);
}

function isoWeekday(dateValue) {
  const match = cleanString(dateValue).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  return day === 0 ? 7 : day;
}

function normalizeScheduleRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => row?.get ? row.get({ plain: true }) : row)
    .filter((row) => row?.activo !== false && Number(row?.dia_semana) >= 1 && Number(row?.dia_semana) <= 7)
    .map((row) => ({
      weekday: Number(row.dia_semana),
      start: cleanString(row.hora_inicio),
      end: cleanString(row.hora_fin),
    }))
    .filter((row) => /^\d{2}:\d{2}$/.test(row.start) && /^\d{2}:\d{2}$/.test(row.end) && row.start < row.end)
    .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
}

function computeNextClinicOpening({ now = new Date(), timeZone = DEFAULT_TIME_ZONE, rows = [], nextDay = false }) {
  const schedule = normalizeScheduleRows(rows);
  if (!schedule.length) return { available: false, reason: 'clinic_hours_not_configured', waitUntil: null };

  const currentLocalDate = localDate(now, timeZone);
  const firstDate = nextDay ? addLocalDays(currentLocalDate, 1) : currentLocalDate;
  for (let dayOffset = 0; dayOffset < 21; dayOffset += 1) {
    const dateValue = addLocalDays(firstDate, dayOffset);
    const intervals = schedule.filter((row) => row.weekday === isoWeekday(dateValue));
    for (const interval of intervals) {
      const start = localDateTimeToUtc(dateValue, interval.start, timeZone);
      const end = localDateTimeToUtc(dateValue, interval.end, timeZone);
      if (!start || !end) continue;
      if (!nextDay && dayOffset === 0 && now >= start && now < end) {
        return { available: true, reason: 'clinic_open_now', waitUntil: now };
      }
      if (start > now) {
        return { available: true, reason: 'next_clinic_opening', waitUntil: start };
      }
    }
  }
  return { available: false, reason: 'clinic_opening_not_found', waitUntil: null };
}

async function resolveLeadAutoReplyWait({ clinicId, scheduleScope, timing, now = new Date(), models = db }) {
  const clinic = await models.Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'configuracion'],
    raw: true,
  });
  if (!clinic) return { available: false, reason: 'clinic_not_found', waitUntil: null };
  const timeZone = resolveClinicTimeZone(clinic);
  const nextDay = timing === 'next_day';

  if (scheduleScope === 'all_days') {
    const waitUntil = nextDay
      ? localDateTimeToUtc(addLocalDays(localDate(now, timeZone), 1), DEFAULT_NEXT_DAY_TIME, timeZone)
      : now;
    return { available: true, reason: nextDay ? 'next_day_09_00' : 'send_now', waitUntil, timeZone };
  }

  const rows = await models.ClinicaHorario.findAll({
    where: { clinica_id: clinicId, activo: true },
    attributes: ['dia_semana', 'hora_inicio', 'hora_fin', 'activo'],
    raw: true,
  });
  return {
    ...computeNextClinicOpening({ now, timeZone, rows, nextDay }),
    timeZone,
  };
}

module.exports = {
  DEFAULT_NEXT_DAY_TIME,
  DEFAULT_TIME_ZONE,
  addLocalDays,
  computeNextClinicOpening,
  localDateTimeToUtc,
  normalizeScheduleRows,
  resolveClinicTimeZone,
  resolveLeadAutoReplyWait,
};
