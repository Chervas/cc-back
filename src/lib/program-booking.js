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
function composeAppointmentProfile(appointment) {
  if (!appointment?.treatments?.length || appointment.treatments.length > 8) error('program_composition_invalid', 'Faltan los tratamientos de esta cita.');
  const phases = [], treatmentIds = [];
  appointment.treatments.forEach((treatment, treatmentIndex) => {
    const profile = normalizeBookingProfile(treatment.booking_profile);
    if (!profile) error('program_profile_missing', 'Completa las cabinas y profesionales de cada tratamiento.');
    if (!Number.isSafeInteger(treatment.id) || treatmentIds.includes(treatment.id)) error('program_composition_invalid', 'Tratamientos no válidos o repetidos en la misma cita.');
    treatmentIds.push(treatment.id);
    profile.phases.forEach((phase, phaseIndex) => phases.push({ ...phase,
      key: `t${treatmentIndex + 1}_p${phaseIndex + 1}`,
      label: [treatment.name, phase.label].filter(Boolean).join(' · ').slice(0, 120),
      treatment_id: treatment.id, treatment_name: treatment.name,
    }));
  });
  const profile = normalizeBookingProfile({ version: phases.some(p => p.equipment_requirements?.length) ? 2 : 1, phases });
  return { profile, treatment_ids: treatmentIds,
    phase_treatments: phases.map(({ key, treatment_id, treatment_name }) => ({ key, treatment_id, treatment_name })),
    duration_minutes: profile.phases.reduce((total, phase) => total + phase.duration_minutes, 0) };
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
  selected.forEach((item, index) => {
    const previous = selected[index - 1];
    if (previous && new Date(previous.end_at) > new Date(item.start_at)) issues.push({ key: item.key, code: 'program_session_order', message: 'Las sesiones deben conservar su orden y no solaparse.' });
    if (rule && previous && item.date < addDays(previous.date, rule.min_days_between)) issues.push({ key: item.key, code: 'program_minimum_gap', message: `Deja al menos ${rule.min_days_between} días entre sesiones.` });
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
    return { key: row.key, start_at: new Date(row.start_at).toISOString(), selections: normalized, priority_acknowledged: row.priority_acknowledged === true };
  }).sort((a, b) => a.key.localeCompare(b.key));
  return { request_key: payload.request_key, snapshot_sha256: payload.snapshot_sha256, sessions,
    request_sha256: hash({ snapshot_sha256: payload.snapshot_sha256, sessions }) };
}

module.exports = { normalizeCadence, composeAppointmentProfile, seriesIssues, weekKey, bookingRequest, programBookingEnabled };
