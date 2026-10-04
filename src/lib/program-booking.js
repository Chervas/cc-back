'use strict';

const { normalizeBookingProfile } = require('./booking-profile');
const { domainError } = require('./treatmentPrograms.contract');
const { addDays } = require('./personal-schedule-recurring');
const { formatDateLocal } = require('./availability-calendar');
const { hash } = require('./cliniccloud-import/adapter');
const error = (code, message, details) => { throw domainError(422, code, message, details); };

function programBookingEnabled(environment = process.env) {
  return ['TREATMENT_PROGRAM_BOOKING_ENABLED', 'TREATMENT_PROGRAM_ECONOMICS_ENABLED',
    'BOOKING_PROFILES_ENABLED', 'BOOKING_MULTI_RESOURCE_ENABLED'].every(key => environment[key] === 'true');
}

function normalizeCadence(value) {
  if (value == null) return null; // Existing explicit offsets remain supported.
  if (!value || Array.isArray(value) || value.mode !== 'weekly'
    || !Number.isInteger(value.sessions_per_week) || value.sessions_per_week < 1 || value.sessions_per_week > 7
    || !Number.isInteger(value.min_days_between) || value.min_days_between < 1 || value.min_days_between > 14) {
    error('program_cadence_invalid', 'Revisa las sesiones por semana y la separación mínima entre días.');
  }
  return { mode: 'weekly', sessions_per_week: value.sessions_per_week, min_days_between: value.min_days_between };
}

// Treatment order is explicit. No permutation of rooms, double billing or
// guessing shorter clinical times when combining treatments.
function normalizeProgramProfile(value, { allowMissingDuration = false } = {}) {
  if (!allowMissingDuration) return normalizeBookingProfile(value);
  const template = normalizeBookingProfile(value, { allowIncomplete: true });
  if (!template) return null;
  // Only duration may be deferred. The incomplete normalizer alone would also
  // permit missing rooms/professionals, which must never become sellable.
  normalizeBookingProfile({ ...template, phases: template.phases.map(phase => ({ ...phase,
    duration_minutes: phase.duration_minutes ?? 1 })) });
  return template;
}
function schedulingMode(value) {
  return value.kind === 'program' && !value.cadence
    && value.appointments.some(appointment => appointment.offset_days == null) ? 'manual' : 'automatic';
}
function composeAppointmentProfile(appointment, { allowMissingDuration = false } = {}) {
  if (!appointment?.treatments?.length || appointment.treatments.length > 8) error('program_composition_invalid', 'Faltan los tratamientos de esta cita.');
  const phases = [], treatmentIds = [];
  appointment.treatments.forEach((treatment, treatmentIndex) => {
    const profile = normalizeProgramProfile(treatment.booking_profile, { allowMissingDuration });
    if (!profile) error('program_profile_missing', 'Completa las cabinas y profesionales de cada tratamiento.');
    if (!Number.isSafeInteger(treatment.id) || treatmentIds.includes(treatment.id)) error('program_composition_invalid', 'Tratamientos no válidos o repetidos en la misma cita.');
    treatmentIds.push(treatment.id);
    profile.phases.forEach((phase, phaseIndex) => phases.push({ ...phase,
      key: `t${treatmentIndex + 1}_p${phaseIndex + 1}`,
      label: [treatment.name, phase.label].filter(Boolean).join(' · ').slice(0, 120),
      treatment_id: treatment.id, treatment_name: treatment.name,
    }));
  });
  const profile = normalizeProgramProfile({ version: phases.some(p => p.staff_attention) ? 3 : phases.some(p => p.equipment_requirements?.length) ? 2 : 1, phases }, { allowMissingDuration });
  return { profile, treatment_ids: treatmentIds,
    phase_treatments: phases.map(({ key, treatment_id, treatment_name }) => ({ key, treatment_id, treatment_name })),
    duration_minutes: profile.phases.some(phase => phase.duration_minutes == null) ? null
      : profile.phases.reduce((total, phase) => total + phase.duration_minutes, 0) };
}

function durationChoice(row) {
  const result = {};
  if (row.duration_minutes != null) {
    if (!Number.isInteger(row.duration_minutes) || row.duration_minutes < 1 || row.duration_minutes > 1440) error('program_duration_invalid', 'Elige una duración entre 1 y 1440 minutos.');
    result.duration_minutes = row.duration_minutes;
  }
  if (row.phase_durations != null) {
    if (!row.phase_durations || typeof row.phase_durations !== 'object' || Array.isArray(row.phase_durations)
      || Object.keys(row.phase_durations).length > 12) error('program_duration_invalid', 'Revisa la duración de cada fase.');
    result.phase_durations = Object.fromEntries(Object.entries(row.phase_durations).sort(([a], [b]) => a.localeCompare(b)).map(([key, minutes]) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) error('program_duration_invalid', 'Revisa la duración de cada fase.');
      return [key, minutes];
    }));
  }
  return result;
}
function materializeSession(session, choice = {}) {
  const supplied = durationChoice(choice);
  const template = normalizeProgramProfile(session.booking_profile, { allowMissingDuration: true });
  if (!template) error('program_profile_missing', 'Falta configurar la sala y el profesional de esta sesión.');
  const missing = template.phases.filter(phase => phase.duration_minutes == null);
  const knownMinutes = template.phases.reduce((total, phase) => total + (phase.duration_minutes || 0), 0);
  const durations = supplied.phase_durations || {};
  if (Object.keys(durations).some(key => !missing.some(phase => phase.key === key))) error('program_duration_locked', 'Solo puedes elegir la duración de las fases que no la tienen definida.');
  const phases = template.phases.map(phase => {
    if (phase.duration_minutes != null) return phase;
    const duration = durations[phase.key] ?? (missing.length === 1 && supplied.duration_minutes != null ? supplied.duration_minutes - knownMinutes : null);
    if (!Number.isInteger(duration) || duration < 1) error('program_duration_required', 'Elige la duración de esta sesión antes de buscar o reservar su cita.', { key: session.key, phase_key: phase.key });
    return { ...phase, duration_minutes: duration };
  });
  const profile = normalizeBookingProfile({ ...template, phases });
  const total = profile.phases.reduce((minutes, phase) => minutes + phase.duration_minutes, 0);
  if (supplied.duration_minutes != null && supplied.duration_minutes !== total) error('program_duration_locked', 'La duración debe respetar las fases ya definidas del tratamiento.');
  return { ...session, booking_profile: profile, duration_minutes: total,
    ...(missing.length ? { duration_selection: { ...supplied, duration_minutes: total } } : {}) };
}

function weekKey(date) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}
function seriesIssues(appointments, cadence, timeZone) {
  const selected = appointments.filter(item => item.start_at).map(item => ({ ...item,
    date: formatDateLocal(new Date(item.start_at), timeZone) }));
  const issues = [], weeks = new Map();
  const rule = normalizeCadence(cadence);
  let previousTimed = null;
  selected.forEach((item, index) => {
    const previous = selected[index - 1];
    if (previous && new Date(previous.end_at) > new Date(item.start_at)) issues.push({ key: item.key, code: 'program_session_order', message: 'Las sesiones deben conservar su orden y no solaparse.' });
    if (rule && previous && item.date < addDays(previous.date, rule.min_days_between)) issues.push({ key: item.key, code: 'program_minimum_gap', message: `Deja al menos ${rule.min_days_between} días entre sesiones.` });
    if (!rule && Number.isSafeInteger(item.offset_days)) {
      // Missing offsets do not license erasing the known part of a protocol.
      // Compare only documented relative days; do not invent a day-0 anchor if
      // the patient enters at a later unit or the first visit is still pending.
      if (previousTimed && item.offset_days > previousTimed.offset_days
        && item.date < addDays(previousTimed.date, item.offset_days - previousTimed.offset_days)) {
        issues.push({ key: item.key, code: 'program_offset_gap', message: `Deja al menos ${item.offset_days - previousTimed.offset_days} días desde la sesión anterior con intervalo definido.` });
      }
      previousTimed = item;
    }
    if (rule) {
      const key = weekKey(item.date), count = (weeks.get(key) || 0) + 1; weeks.set(key, count);
      if (count > rule.sessions_per_week) issues.push({ key: item.key, code: 'program_weekly_limit', message: `La pauta admite como máximo ${rule.sessions_per_week} sesiones por semana.` });
    }
  });
  return issues;
}

function bookingRequest(payload) {
  if (!payload || !/^[a-zA-Z0-9_-]{8,80}$/.test(payload.request_key || '') || !/^[a-f0-9]{64}$/.test(payload.snapshot_sha256 || '')) error('program_booking_request_invalid', 'Actualiza el plan antes de reservar.');
  if (!Array.isArray(payload.sessions) || !payload.sessions.length || payload.sessions.length > 30) error('program_booking_batch_invalid', 'Selecciona entre una y treinta sesiones.');
  const keys = new Set();
  const sessions = payload.sessions.map(row => {
    if (!row || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.key || '') || keys.has(row.key)
      || typeof row.start_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/.test(row.start_at)
      || !Number.isFinite(Date.parse(row.start_at))) error('program_booking_session_invalid', 'Revisa las sesiones y las horas elegidas.');
    if (new Date(row.start_at).toISOString().slice(0, 19) !== row.start_at.slice(0, 19)) error('program_booking_session_invalid', 'La fecha elegida no existe.');
    keys.add(row.key);
    const selections = row.selections || {};
    if (typeof selections !== 'object' || Array.isArray(selections) || Object.keys(selections).length > 12) error('program_booking_selection_invalid', 'Selecciona cabina y profesional válidos.');
    const normalized = Object.create(null);
    for (const [key, choice] of Object.entries(selections)) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || !choice || typeof choice !== 'object' || Array.isArray(choice)
        || Object.keys(choice).some(field => !['doctor_id', 'installation_id'].includes(field))) error('program_booking_selection_invalid', 'Selección de fase no válida.');
      normalized[key] = {};
      for (const [field, id] of Object.entries(choice)) {
        if (!Number.isSafeInteger(id) || id < 1) error('program_booking_selection_invalid', 'Identificador de recurso no válido.');
        normalized[key][field] = id;
      }
    }
    if (row.priority_acknowledged != null && typeof row.priority_acknowledged !== 'boolean') error('program_booking_selection_invalid', 'Confirma expresamente el cambio de profesional.');
    return { key: row.key, start_at: new Date(row.start_at).toISOString(), selections: normalized, priority_acknowledged: row.priority_acknowledged === true,
      ...durationChoice(row) };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const resume = require('./program-replan').resumeInput(payload);
  const contents = { snapshot_sha256: payload.snapshot_sha256, sessions, ...(resume || {}) };
  return { request_key: payload.request_key, ...contents, request_sha256: hash(contents) };
}

module.exports = { normalizeCadence, composeAppointmentProfile, normalizeProgramProfile, schedulingMode, durationChoice,
  materializeSession, seriesIssues, weekKey, bookingRequest, programBookingEnabled };
