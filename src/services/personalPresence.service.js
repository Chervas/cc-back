'use strict';

const { randomUUID } = require('crypto');
const db = require('../../models');
const { Op } = db.Sequelize;
const {
  buildHorarioExceptionMap,
  expandHorariosForDate,
  normalizeDateOnly,
} = require('../lib/personal-schedule-recurring');
const { getAccessibleClinicIdsForFeature } = require('../lib/access-policy');
const { isGlobalAdmin } = require('../lib/role-helpers');
const {
  DEFAULT_TIME_ZONE,
  resolveClinicTimeZone,
} = require('./clinicOpeningHours.service');

const {
  Clinica,
  DoctorClinica,
  DoctorHorario,
  DoctorHorarioExcepcion,
  PersonalPresenceEvent,
  Usuario,
  UsuarioClinica,
} = db;

const PRESENCE_EVENT_TYPES = new Set(['clock_in', 'break_start', 'break_end', 'clock_out']);
const ACTIVE_STAFF_INVITATION_WHERE = {
  [Op.or]: [
    { estado_invitacion: 'aceptada' },
    { estado_invitacion: null },
  ],
};

function toInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function domainError(message, status = 400, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function dateOnly(date, timeZone = DEFAULT_TIME_ZONE) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function timeLabel(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('es-ES', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fullName(row, fallback = 'Usuario') {
  return [row?.nombre, row?.apellidos].filter(Boolean).join(' ').trim()
    || row?.email_usuario
    || fallback;
}

function roleLabel(pivot) {
  const subrole = cleanString(pivot?.subrol_clinica);
  if (subrole) return subrole;
  const role = cleanString(pivot?.rol_clinica);
  if (role === 'propietario') return 'Propietario';
  if (role === 'personaldeclinica') return 'Personal de clínica';
  return role || 'Equipo';
}

function eventTypeLabel(type) {
  switch (String(type || '')) {
    case 'clock_in': return 'Entrada';
    case 'break_start': return 'Pausa';
    case 'break_end': return 'Reanudacion';
    case 'clock_out': return 'Salida';
    default: return 'Evento';
  }
}

function statusLabel(status) {
  switch (String(status || '')) {
    case 'open': return 'Jornada abierta';
    case 'break': return 'En pausa';
    case 'closed': return 'Jornada cerrada';
    case 'pending':
    default: return 'Sin entrada';
  }
}

function hmToMinutes(value) {
  const match = cleanString(value).match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number.isFinite(minutes) ? minutes : null;
}

function minutesLabel(totalMinutes) {
  const total = Math.max(0, Math.round(Number(totalMinutes || 0)));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours <= 0) return `${minutes} min`;
  if (minutes <= 0) return `${hours} h`;
  return `${hours} h ${minutes} min`;
}

function differenceLabel(value) {
  if (value === null || value === undefined) return 'Sin horario previsto';
  const rounded = Math.round(Number(value || 0));
  if (rounded === 0) return '0 min';
  return `${rounded > 0 ? '+' : '-'} ${minutesLabel(Math.abs(rounded))}`;
}

function intervalMinutes(intervals) {
  return (intervals || []).reduce((total, interval) => {
    const start = hmToMinutes(interval.hora_inicio);
    const end = hmToMinutes(interval.hora_fin);
    return start !== null && end !== null && end > start ? total + (end - start) : total;
  }, 0);
}

function computeWorkedMinutes(events, now = new Date()) {
  let total = 0;
  let openedAt = null;
  let pauseStartedAt = null;
  let pausedMs = 0;

  for (const event of events || []) {
    const occurredAt = event.occurred_at instanceof Date ? event.occurred_at : new Date(event.occurred_at);
    if (Number.isNaN(occurredAt.getTime())) continue;

    if (event.event_type === 'clock_in') {
      openedAt = openedAt || occurredAt;
      pauseStartedAt = null;
      pausedMs = 0;
    } else if (event.event_type === 'break_start' && openedAt && !pauseStartedAt) {
      pauseStartedAt = occurredAt;
    } else if (event.event_type === 'break_end' && openedAt && pauseStartedAt) {
      pausedMs += Math.max(0, occurredAt.getTime() - pauseStartedAt.getTime());
      pauseStartedAt = null;
    } else if (event.event_type === 'clock_out' && openedAt) {
      const extraPauseMs = pauseStartedAt ? Math.max(0, occurredAt.getTime() - pauseStartedAt.getTime()) : 0;
      total += Math.max(0, occurredAt.getTime() - openedAt.getTime() - pausedMs - extraPauseMs);
      openedAt = null;
      pauseStartedAt = null;
      pausedMs = 0;
    }
  }

  if (openedAt) {
    const extraPauseMs = pauseStartedAt ? Math.max(0, now.getTime() - pauseStartedAt.getTime()) : 0;
    total += Math.max(0, now.getTime() - openedAt.getTime() - pausedMs - extraPauseMs);
  }

  return Math.round(total / 60000);
}

function lastEvent(events) {
  return [...(events || [])].sort((a, b) => {
    const left = new Date(a.occurred_at).getTime();
    const right = new Date(b.occurred_at).getTime();
    return left - right || Number(a.id || 0) - Number(b.id || 0);
  }).at(-1) || null;
}

function rowStatus(events) {
  const last = lastEvent(events);
  if (!last) return 'pending';
  if (last.event_type === 'clock_out') return 'closed';
  if (last.event_type === 'break_start') return 'break';
  return 'open';
}

function serializeEvents(events, timeZone) {
  return (events || []).map((event) => ({
    id: String(event.public_id || event.id),
    event_type: event.event_type,
    type: eventTypeLabel(event.event_type),
    time: timeLabel(event.occurred_at, timeZone),
    occurred_at: event.occurred_at instanceof Date ? event.occurred_at.toISOString() : new Date(event.occurred_at).toISOString(),
    source: event.source || 'web',
    note: event.note || null,
  }));
}

function normalizeClinicDate(rawDate, clinic, now = new Date()) {
  const timeZone = resolveClinicTimeZone(clinic);
  return {
    businessDate: normalizeDateOnly(rawDate) || dateOnly(now, timeZone),
    timeZone,
  };
}

async function loadClinic(clinicId) {
  if (!Clinica) throw domainError('clinic_model_unavailable', 503);
  const clinic = await Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'nombre_clinica', 'url_avatar', 'configuracion'],
    raw: true,
  });
  if (!clinic) throw domainError('clinic_not_found', 404);
  return clinic;
}

async function assertFeatureAccess(actorId, clinicId, featureKey) {
  if (isGlobalAdmin(actorId)) return;
  const allowedIds = await getAccessibleClinicIdsForFeature({
    actorId,
    featureKey,
    clinicIds: [clinicId],
  });
  if (!allowedIds.map(Number).includes(Number(clinicId))) {
    throw domainError('presence_scope_forbidden', 403);
  }
}

async function fallbackActorClinicId(actorId) {
  const pivot = await UsuarioClinica.findOne({
    where: {
      id_usuario: Number(actorId),
      rol_clinica: { [Op.in]: ['propietario', 'personaldeclinica'] },
      ...ACTIVE_STAFF_INVITATION_WHERE,
    },
    order: [['id_clinica', 'ASC']],
    attributes: ['id_clinica'],
    raw: true,
  });
  return toInt(pivot?.id_clinica);
}

async function resolveClinicId(actorId, query = {}) {
  const explicit = toInt(query.clinica_id || query.clinic_id || query.clinicId);
  if (explicit) return explicit;
  const fallback = await fallbackActorClinicId(actorId);
  if (fallback) return fallback;
  throw domainError('clinica_id_required', 400);
}

async function buildPresenceRowsForClinic({ clinicId, clinic: clinicInput = null, businessDate = null, now = new Date() }) {
  if (!PersonalPresenceEvent) throw domainError('presence_model_unavailable', 503);

  const clinic = clinicInput || await loadClinic(clinicId);
  const { businessDate: dateValue, timeZone } = normalizeClinicDate(businessDate, clinic, now);

  const pivots = await UsuarioClinica.findAll({
    where: {
      id_clinica: Number(clinicId),
      rol_clinica: { [Op.in]: ['propietario', 'personaldeclinica'] },
      ...ACTIVE_STAFF_INVITATION_WHERE,
    },
    include: [{
      model: Usuario,
      as: 'Usuario',
      attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario', 'avatar', 'cargo_usuario'],
      required: true,
    }],
    order: [
      ['rol_clinica', 'ASC'],
      ['subrol_clinica', 'ASC'],
      ['id_usuario', 'ASC'],
    ],
  });

  const staff = pivots.map((pivot) => {
    const json = pivot.toJSON();
    return {
      pivot: json,
      user: json.Usuario || {},
      userId: toInt(json.id_usuario),
    };
  }).filter((item) => (
    item.userId
    && cleanString(item.pivot?.subrol_clinica).toLowerCase() !== 'gestoría'
  ));

  const userIds = staff.map((item) => item.userId);
  const events = userIds.length
    ? await PersonalPresenceEvent.findAll({
        where: {
          clinic_id: Number(clinicId),
          business_date: dateValue,
          user_id: { [Op.in]: userIds },
        },
        order: [['occurred_at', 'ASC'], ['id', 'ASC']],
        raw: true,
      })
    : [];
  const eventsByUser = new Map();
  for (const event of events) {
    const list = eventsByUser.get(Number(event.user_id)) || [];
    list.push(event);
    eventsByUser.set(Number(event.user_id), list);
  }

  const doctorClinicas = userIds.length
    ? await DoctorClinica.findAll({
        where: {
          clinica_id: Number(clinicId),
          doctor_id: { [Op.in]: userIds },
          activo: true,
        },
        attributes: ['id', 'doctor_id', 'clinica_id', 'rol_en_clinica'],
        raw: true,
      })
    : [];
  const doctorClinicaIds = doctorClinicas.map((row) => Number(row.id)).filter(Boolean);
  const horarios = doctorClinicaIds.length
    ? await DoctorHorario.findAll({
        where: {
          doctor_clinica_id: { [Op.in]: doctorClinicaIds },
          activo: true,
        },
        raw: true,
      })
    : [];
  const exceptions = horarios.length
    ? await DoctorHorarioExcepcion.findAll({
        where: {
          doctor_horario_id: { [Op.in]: horarios.map((row) => Number(row.id)).filter(Boolean) },
          fecha: dateValue,
        },
        raw: true,
      })
    : [];
  const exceptionMap = buildHorarioExceptionMap(exceptions);
  const linksByUser = new Map();
  for (const link of doctorClinicas) {
    const list = linksByUser.get(Number(link.doctor_id)) || [];
    list.push(link);
    linksByUser.set(Number(link.doctor_id), list);
  }
  const horariosByDoctorClinica = new Map();
  for (const horario of horarios) {
    const list = horariosByDoctorClinica.get(Number(horario.doctor_clinica_id)) || [];
    list.push(horario);
    horariosByDoctorClinica.set(Number(horario.doctor_clinica_id), list);
  }

  const rows = staff.map(({ pivot, user, userId }) => {
    const links = linksByUser.get(Number(userId)) || [];
    const intervals = links.flatMap((link) =>
      expandHorariosForDate(horariosByDoctorClinica.get(Number(link.id)) || [], dateValue, exceptionMap)
    ).sort((a, b) => a.hora_inicio.localeCompare(b.hora_inicio));
    const expectedMinutes = intervalMinutes(intervals);
    const userEvents = eventsByUser.get(Number(userId)) || [];
    const workedMinutes = computeWorkedMinutes(userEvents, now);
    const status = rowStatus(userEvents);
    const last = lastEvent(userEvents);
    const firstIn = userEvents.find((event) => event.event_type === 'clock_in') || null;
    const difference = expectedMinutes > 0 ? workedMinutes - expectedMinutes : null;
    const issue = status === 'pending' && expectedMinutes > 0
      ? 'Sin entrada'
      : status === 'open'
        ? 'Salida pendiente'
        : status === 'break'
          ? 'Pausa abierta'
          : difference !== null && Math.abs(difference) >= 15
            ? `Diferencia ${differenceLabel(difference)}`
            : null;

    return {
      id: String(userId),
      userId,
      clinicId: Number(clinicId),
      clinicName: clinic.nombre_clinica || 'Clínica',
      name: fullName(user, `Usuario ${userId}`),
      avatar: user.avatar || null,
      role: roleLabel(pivot),
      expected: intervals.length
        ? intervals.map((interval) => `${interval.hora_inicio}-${interval.hora_fin}`).join(' / ')
        : 'Sin horario',
      expected_minutes: expectedMinutes,
      worked: minutesLabel(workedMinutes),
      worked_minutes: workedMinutes,
      difference: differenceLabel(difference),
      difference_minutes: difference,
      status,
      statusLabel: statusLabel(status),
      lastEventType: last?.event_type || null,
      lastEventLabel: last ? `${eventTypeLabel(last.event_type)} ${timeLabel(last.occurred_at, timeZone)}` : 'Sin fichaje',
      firstInLabel: firstIn ? timeLabel(firstIn.occurred_at, timeZone) : 'Pendiente',
      issue,
      events: serializeEvents(userEvents, timeZone),
    };
  });

  return {
    clinic: {
      id: Number(clinicId),
      name: clinic.nombre_clinica || 'Clínica',
      time_zone: timeZone,
    },
    business_date: dateValue,
    rows,
  };
}

async function getPresenceWorkspace({ actorId, query = {} }) {
  const safeActorId = toInt(actorId);
  if (!safeActorId) throw domainError('unauthenticated', 401);

  const clinicId = await resolveClinicId(safeActorId, query);
  await assertFeatureAccess(safeActorId, clinicId, 'team.view');

  const clinic = await loadClinic(clinicId);
  const built = await buildPresenceRowsForClinic({
    clinicId,
    clinic,
    businessDate: query.date || query.fecha || null,
  });
  const me = built.rows.find((row) => Number(row.userId) === Number(safeActorId)) || null;

  return {
    clinic: built.clinic,
    business_date: built.business_date,
    me,
    events: me?.events || [],
    team: built.rows,
    summary: summarizeRows(built.rows),
    permissions: {
      can_clock: true,
      can_view_team: true,
    },
    meta: {
      generated_at: new Date().toISOString(),
      source: 'backend',
    },
  };
}

function summarizeRows(rows) {
  const total = rows.length;
  const pending = rows.filter((row) => row.status === 'pending').length;
  const open = rows.filter((row) => row.status === 'open').length;
  const onBreak = rows.filter((row) => row.status === 'break').length;
  const closed = rows.filter((row) => row.status === 'closed').length;
  return {
    total,
    clocked_in: total - pending,
    pending,
    open,
    break: onBreak,
    closed,
  };
}

function isValidTransition(lastType, nextType) {
  if (!lastType) return nextType === 'clock_in';
  if (lastType === 'clock_in') return ['break_start', 'clock_out'].includes(nextType);
  if (lastType === 'break_start') return nextType === 'break_end';
  if (lastType === 'break_end') return ['break_start', 'clock_out'].includes(nextType);
  if (lastType === 'clock_out') return nextType === 'clock_in';
  return false;
}

async function createPresenceEvent({ actorId, payload = {} }) {
  const safeActorId = toInt(actorId);
  if (!safeActorId) throw domainError('unauthenticated', 401);
  if (!PersonalPresenceEvent) throw domainError('presence_model_unavailable', 503);

  const clinicId = toInt(payload.clinic_id || payload.clinica_id || payload.clinicId);
  if (!clinicId) throw domainError('clinica_id_required', 400);
  const eventType = cleanString(payload.event_type || payload.type).toLowerCase();
  if (!PRESENCE_EVENT_TYPES.has(eventType)) {
    throw domainError('presence_event_type_invalid', 400);
  }

  await assertFeatureAccess(safeActorId, clinicId, 'team.schedule.self.manage');
  const clinic = await loadClinic(clinicId);
  const { businessDate } = normalizeClinicDate(payload.business_date || payload.date || payload.fecha, clinic);

  const previousEvents = await PersonalPresenceEvent.findAll({
    where: {
      clinic_id: clinicId,
      user_id: safeActorId,
      business_date: businessDate,
    },
    order: [['occurred_at', 'ASC'], ['id', 'ASC']],
    raw: true,
  });
  const previousLastType = lastEvent(previousEvents)?.event_type || null;
  if (!isValidTransition(previousLastType, eventType)) {
    throw domainError('presence_event_transition_invalid', 409, {
      last_event_type: previousLastType,
      requested_event_type: eventType,
    });
  }

  await PersonalPresenceEvent.create({
    public_id: randomUUID(),
    clinic_id: clinicId,
    user_id: safeActorId,
    business_date: businessDate,
    event_type: eventType,
    occurred_at: new Date(),
    source: 'web',
    note: cleanString(payload.note) || null,
    created_by: safeActorId,
  });

  return getPresenceWorkspace({
    actorId: safeActorId,
    query: { clinica_id: clinicId, date: businessDate },
  });
}

async function getDashboardPresenceSummary({
  clinicIds = [],
  clinicMap = new Map(),
  businessDate = null,
  actorId = null,
}) {
  const ids = [...new Set((clinicIds || []).map(toInt).filter(Boolean))];
  if (!ids.length || !PersonalPresenceEvent) return null;

  const perClinic = [];
  for (const clinicId of ids) {
    const clinic = clinicMap instanceof Map ? clinicMap.get(Number(clinicId)) : null;
    perClinic.push(await buildPresenceRowsForClinic({ clinicId, clinic, businessDate }));
  }
  const rows = perClinic.flatMap((item) => item.rows);
  const summary = summarizeRows(rows);
  const safeActorId = toInt(actorId);
  const me = safeActorId
    ? rows.find((row) => Number(row.userId) === Number(safeActorId)) || null
    : null;
  const serializeDashboardRow = (row) => ({
    id: `${row.clinicId}:${row.userId}`,
    userId: row.userId,
    clinicId: row.clinicId,
    clinicName: row.clinicName,
    name: row.name,
    avatar: row.avatar || null,
    role: row.role,
    expected: row.expected,
    expected_minutes: row.expected_minutes,
    worked: row.worked,
    worked_minutes: row.worked_minutes,
    difference: row.difference,
    difference_minutes: row.difference_minutes,
    status: row.status,
    statusLabel: row.statusLabel,
    lastEventType: row.lastEventType,
    lastEventLabel: row.lastEventLabel,
    firstInLabel: row.firstInLabel,
    issue: row.issue,
  });

  return {
    businessDate: normalizeDateOnly(businessDate) || perClinic[0]?.business_date || dateOnly(new Date()),
    generatedAt: new Date().toISOString(),
    ...summary,
    me: me ? serializeDashboardRow(me) : null,
    rows: rows.slice(0, 12).map(serializeDashboardRow),
  };
}

module.exports = {
  PRESENCE_EVENT_TYPES,
  createPresenceEvent,
  getDashboardPresenceSummary,
  getPresenceWorkspace,
  __testing: {
    computeWorkedMinutes,
    isValidTransition,
    rowStatus,
  },
};
