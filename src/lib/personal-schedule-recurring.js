'use strict';

function normalizeHm(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function normalizeDateOnly(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function dayIndexFromDate(dateIso) {
  const normalized = normalizeDateOnly(dateIso);
  if (!normalized) return null;
  return new Date(`${normalized}T12:00:00Z`).getUTCDay();
}

function toEpochDay(dateIso) {
  const normalized = normalizeDateOnly(dateIso);
  if (!normalized) return null;
  return Math.floor(new Date(`${normalized}T00:00:00Z`).getTime() / 86400000);
}

function addDays(dateIso, days) {
  const epochDay = toEpochDay(dateIso);
  if (epochDay == null || !Number.isFinite(Number(days))) return null;
  const date = new Date((epochDay + Number(days)) * 86400000);
  return date.toISOString().slice(0, 10);
}

function eachDateInclusive(fromIso, toIso) {
  const fromDay = toEpochDay(fromIso);
  const toDay = toEpochDay(toIso);
  if (fromDay == null || toDay == null || fromDay > toDay) return [];
  const out = [];
  for (let day = fromDay; day <= toDay; day += 1) {
    out.push(new Date(day * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

function parseRRule(rrule) {
  if (!rrule) return null;
  if (typeof rrule !== 'string') return null;
  const parts = rrule
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const map = {};
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) return null;
    map[part.slice(0, idx).toUpperCase()] = part.slice(idx + 1).trim();
  }

  const freq = String(map.FREQ || '').toUpperCase();
  if (freq !== 'WEEKLY') return null;

  const interval = Number(map.INTERVAL || 1);
  if (!Number.isFinite(interval) || interval < 1) return null;

  const until = map.UNTIL
    ? normalizeDateOnly(
        map.UNTIL.includes('-')
          ? map.UNTIL
          : `${map.UNTIL.slice(0, 4)}-${map.UNTIL.slice(4, 6)}-${map.UNTIL.slice(6, 8)}`
      )
    : null;

  const count = map.COUNT != null ? Number(map.COUNT) : null;
  if (map.COUNT != null && (!Number.isFinite(count) || count < 1)) return null;

  return {
    freq,
    interval,
    until,
    count,
  };
}

function validateHorarioRecurrenceFields({ dia_semana, rrule, fecha_inicio_vigencia, fecha_fin_vigencia }) {
  const startDate = normalizeDateOnly(fecha_inicio_vigencia);
  const endDate = normalizeDateOnly(fecha_fin_vigencia);
  if (fecha_inicio_vigencia != null && !startDate) {
    return 'fecha_inicio_vigencia inválida';
  }
  if (fecha_fin_vigencia != null && !endDate) {
    return 'fecha_fin_vigencia inválida';
  }
  if (startDate && endDate && startDate > endDate) {
    return 'fecha_fin_vigencia debe ser mayor o igual que fecha_inicio_vigencia';
  }

  if (!rrule) return null;
  const parsed = parseRRule(rrule);
  if (!parsed) {
    return 'rrule inválido. Solo se soporta FREQ=WEEKLY;INTERVAL=N[;UNTIL=YYYY-MM-DD][;COUNT=N]';
  }

  if (!startDate) {
    return 'fecha_inicio_vigencia es obligatoria cuando rrule está informado';
  }

  const expectedDow = dayIndexFromDate(startDate);
  if (expectedDow == null || Number(expectedDow) !== Number(dia_semana)) {
    return 'fecha_inicio_vigencia debe coincidir con dia_semana';
  }

  return null;
}

function buildHorarioExceptionMap(exceptionRows = []) {
  const map = new Map();
  for (const row of exceptionRows || []) {
    const horarioId = Number(row?.doctor_horario_id);
    const fecha = normalizeDateOnly(row?.fecha);
    if (!Number.isFinite(horarioId) || !fecha) continue;
    const list = map.get(horarioId) || [];
    list.push(row);
    map.set(horarioId, list);
  }
  return map;
}

function buildBloqueoExceptionMap(exceptionRows = []) {
  const map = new Map();
  for (const row of exceptionRows || []) {
    const bloqueoId = Number(row?.doctor_bloqueo_id);
    const fecha = normalizeDateOnly(row?.fecha);
    if (!Number.isFinite(bloqueoId) || !fecha) continue;
    const list = map.get(bloqueoId) || [];
    list.push(row);
    map.set(bloqueoId, list);
  }
  return map;
}

function matchesHorarioOnDate(horario, dateIso) {
  if (!horario || horario.activo === false) return false;
  const date = normalizeDateOnly(dateIso);
  if (!date) return false;

  const rowDow = Number(horario.dia_semana);
  if (!Number.isFinite(rowDow) || rowDow !== dayIndexFromDate(date)) return false;

  const vigenciaStart = normalizeDateOnly(horario.fecha_inicio_vigencia);
  const vigenciaEnd = normalizeDateOnly(horario.fecha_fin_vigencia);
  if (vigenciaStart && date < vigenciaStart) return false;
  if (vigenciaEnd && date > vigenciaEnd) return false;

  if (!horario.rrule) return true;
  const parsed = parseRRule(horario.rrule);
  if (!parsed) return false;

  const anchor = vigenciaStart;
  if (!anchor || date < anchor) return false;
  if (parsed.until && date > parsed.until) return false;

  const weeksSinceAnchor = Math.floor((toEpochDay(date) - toEpochDay(anchor)) / 7);
  if (weeksSinceAnchor < 0) return false;
  if (weeksSinceAnchor % parsed.interval !== 0) return false;
  if (parsed.count != null) {
    const occurrenceIndex = Math.floor(weeksSinceAnchor / parsed.interval);
    if (occurrenceIndex >= parsed.count) return false;
  }
  return true;
}

function expandHorariosForDate(horarios = [], dateIso, exceptionMap = new Map()) {
  const normalizedDate = normalizeDateOnly(dateIso);
  if (!normalizedDate) return [];

  const out = [];
  for (const horario of horarios || []) {
    if (!matchesHorarioOnDate(horario, normalizedDate)) continue;

    const exceptions = exceptionMap.get(Number(horario.id)) || [];
    const exception = exceptions
      .filter((row) => normalizeDateOnly(row.fecha) === normalizedDate)
      .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];

    if (exception?.cancelado) continue;

    const overrideStart = normalizeHm(exception?.hora_inicio_override);
    const overrideEnd = normalizeHm(exception?.hora_fin_override);
    const start = overrideStart || normalizeHm(horario.hora_inicio);
    const end = overrideEnd || normalizeHm(horario.hora_fin);
    if (!start || !end || start >= end) continue;

    out.push({
      horario_id: Number(horario.id),
      doctor_clinica_id: Number(horario.doctor_clinica_id),
      fecha: normalizedDate,
      dia_semana: Number(horario.dia_semana),
      hora_inicio: start,
      hora_fin: end,
      activo: true,
      source: exception ? 'exception_override' : 'base',
      rrule: horario.rrule || null,
      fecha_inicio_vigencia: normalizeDateOnly(horario.fecha_inicio_vigencia),
      fecha_fin_vigencia: normalizeDateOnly(horario.fecha_fin_vigencia),
      exception_id: exception?.id != null ? Number(exception.id) : null,
    });
  }
  return out.sort((a, b) => a.hora_inicio.localeCompare(b.hora_inicio));
}

function expandHorariosForRange(horarios = [], fromIso, toIso, exceptionMap = new Map()) {
  const dates = eachDateInclusive(fromIso, toIso);
  const out = [];
  for (const dateIso of dates) {
    out.push(...expandHorariosForDate(horarios, dateIso, exceptionMap));
  }
  return out;
}

module.exports = {
  normalizeHm,
  normalizeDateOnly,
  addDays,
  eachDateInclusive,
  parseRRule,
  validateHorarioRecurrenceFields,
  buildHorarioExceptionMap,
  buildBloqueoExceptionMap,
  expandHorariosForDate,
  expandHorariosForRange,
  matchesHorarioOnDate,
  dayIndexFromDate,
};
