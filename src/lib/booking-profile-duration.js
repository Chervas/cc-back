'use strict';

const { normalizeProgramProfile, materializeSession } = require('./program-booking');
const { bookingProfileDurationMinutes } = require('./booking-profile');
const { assessStaffAttention } = require('./booking-attention');

function fail(code, message, details = null) {
  const error = Object.assign(new Error(message), { code, status: 422, statusCode: 422 });
  if (details) error.details = { ...details, can_force: false };
  throw error;
}

// Request duration is not a catalog mutation. Only an explicitly configured
// physical template may be instantiated; resources and fixed times are locked.
function normalizeDurationSelection(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['duration_minutes', 'phase_durations'].includes(key))) {
    fail('booking_duration_invalid', 'Revisa la duración elegida para esta cita.');
  }
  const selection = {};
  if (Object.hasOwn(value, 'duration_minutes')) {
    if (!Number.isInteger(value.duration_minutes) || value.duration_minutes < 1 || value.duration_minutes > 1440) {
      fail('booking_duration_invalid', 'Elige una duración entre 1 y 1440 minutos.');
    }
    selection.duration_minutes = value.duration_minutes;
  }
  if (Object.hasOwn(value, 'phase_durations')) {
    const durations = value.phase_durations;
    if (!durations || typeof durations !== 'object' || Array.isArray(durations)
      || Object.keys(durations).length > 12) fail('booking_duration_invalid', 'Revisa la duración de cada paso.');
    selection.phase_durations = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => a.localeCompare(b)).map(([key, minutes]) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key) || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        fail('booking_duration_invalid', 'Cada paso debe tener una duración entera entre 1 y 1440 minutos.');
      }
      return [key, minutes];
    }));
  }
  return selection;
}

function durationRequirements(profile) {
  const missing = (profile?.phases || []).filter(phase => phase.duration_minutes == null);
  return { required: missing.length > 0, input: profile?.phases.length === 1 ? 'duration_minutes' : 'phase_durations',
    phases: missing.map(({ key, label }) => ({ key, label })) };
}

function resolveBookingProfileDuration(value, { durationSelection, allowMissingDuration = false } = {}) {
  const selection = normalizeDurationSelection(durationSelection);
  const template = normalizeProgramProfile(value, { allowMissingDuration: true });
  if (!template) {
    if (selection !== undefined) fail('booking_profile_missing', 'Configura la sala y el profesional del tratamiento antes de elegir su duración.');
    return { profile: null, duration_selection: null };
  }
  const requirements = durationRequirements(template);
  if (requirements.required && selection === undefined && allowMissingDuration) return { profile: template, duration_selection: null };
  if (requirements.required) {
    const keys = requirements.phases.map(phase => phase.key);
    if (template.phases.length === 1 ? selection?.duration_minutes == null
      : keys.some(key => !Object.hasOwn(selection?.phase_durations || {}, key))) {
      fail('booking_duration_required', template.phases.length === 1
        ? 'Elige la duración de esta cita antes de buscar disponibilidad o guardarla.'
        : 'Elige la duración de cada paso pendiente antes de buscar disponibilidad o guardar la cita.',
      { duration_requirements: requirements });
    }
  }
  let result;
  try { result = materializeSession({ key: 'individual', booking_profile: template }, selection || {}); }
  catch (error) {
    if (String(error.code || '').startsWith('program_duration_')) fail(error.code.replace('program_', 'booking_'), error.message,
      { duration_requirements: requirements });
    throw error;
  }
  // An entered duration must contain the quantified preparation/end windows.
  // Test each policy structurally, without inventing clinical time or a slot.
  if (requirements.required) for (const phase of result.booking_profile.phases) {
    if (!phase.staff_attention?.length) continue;
    const start = new Date('2030-01-01T00:00:00.000Z');
    const end = new Date(+start + phase.duration_minutes * 60000);
    const decision = assessStaffAttention({ start, end, policies: phase.staff_attention,
      resource: { windows: [{ start, end }], busy: [] }, maxAttempts: 4096 });
    if (decision.status !== 'planned') fail('booking_duration_attention_invalid',
      'La duración elegida no permite respetar los tiempos de atención de este paso.', { phase_key: phase.key });
  }
  return { profile: result.booking_profile, duration_selection: requirements.required ? {
    duration_minutes: bookingProfileDurationMinutes(result.booking_profile),
    phase_durations: Object.fromEntries(result.booking_profile.phases.filter(phase => requirements.phases.some(item => item.key === phase.key))
      .map(phase => [phase.key, phase.duration_minutes])),
  } : null };
}

// Only the HTTP boundary parses strings. Internal services accept integers.
// Legacy duracion_min is a choice solely for a physical template with null
// duration; it never enables the new contract on an unprofiled treatment.
function durationSelectionForRequest(treatment, input = {}, { query = false } = {}) {
  const selection = {};
  if (Object.hasOwn(input, 'duration_minutes')) {
    const raw = input.duration_minutes;
    selection.duration_minutes = query && typeof raw === 'string' && /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : raw;
  }
  if (Object.hasOwn(input, 'phase_durations')) {
    let raw = input.phase_durations;
    if (query && typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { fail('booking_duration_invalid', 'Revisa la duración de cada paso.'); } }
    selection.phase_durations = raw;
  }
  if (!Object.keys(selection).length && input.duracion_min != null) {
    let config = treatment?.clinical_config;
    if (typeof config === 'string') { try { config = JSON.parse(config); } catch { config = null; } }
    if (config?.booking_profile?.phases?.some(phase => phase.duration_minutes == null || phase.duration_minutes === '')) {
      const raw = input.duracion_min;
      selection.duration_minutes = typeof raw === 'string' && /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : raw;
    }
  }
  return Object.keys(selection).length ? normalizeDurationSelection(selection) : undefined;
}

module.exports = { normalizeDurationSelection, resolveBookingProfileDuration, durationSelectionForRequest, durationRequirements };
