'use strict';

const MINUTE = 60000;
const continuous = () => ({ mode: 'continuous', patient_preparation_minutes: 0 });
function invalid(message) {
  throw Object.assign(new Error(message), { code: 'booking_attention_invalid', status: 400, statusCode: 400 });
}
function minutes(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max || value % 5) invalid(`${name}: indica minutos en pasos de 5, entre ${min} y ${max}.`);
  return value;
}
function normalizeAttentionPolicy(input) {
  if (input == null) return continuous();
  if (typeof input !== 'object' || Array.isArray(input)) invalid('Revisa la intervención del profesional.');
  if (input.mode === 'continuous') {
    if (Object.keys(input).some(key => !['mode', 'patient_preparation_minutes'].includes(key))) invalid('La atención continua no admite tiempos de inicio y final.');
    return { mode: 'continuous', patient_preparation_minutes: minutes(input.patient_preparation_minutes ?? 0, 'Preparación del paciente', 0, 30) };
  }
  if (input.mode !== 'start_end' || Object.keys(input).some(key => !['mode', 'start_minutes', 'start_window_minutes', 'end_minutes', 'end_window_minutes'].includes(key))) invalid('Elige atención continua o intervención al inicio y al final.');
  const policy = { mode: 'start_end',
    start_minutes: minutes(input.start_minutes, 'Intervención inicial', 5, 30),
    start_window_minutes: minutes(input.start_window_minutes, 'Ventana inicial', 5, 60),
    end_minutes: minutes(input.end_minutes, 'Intervención final', 5, 30),
    end_window_minutes: minutes(input.end_window_minutes, 'Ventana final', 5, 60) };
  if (policy.start_minutes > policy.start_window_minutes || policy.end_minutes > policy.end_window_minutes) invalid('La intervención debe caber completa dentro de su ventana.');
  return policy;
}
const isDefaultAttention = policy => policy.mode === 'continuous' && policy.patient_preparation_minutes === 0;
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
function free(resource, interval, reserved) {
  return resource?.windows?.some(window => +new Date(window.start) <= interval.start && interval.end <= +new Date(window.end))
    && !(resource.busy || []).some(busy => overlaps(interval, { start: +new Date(busy.start), end: +new Date(busy.end) }))
    && !reserved.some(busy => overlaps(interval, busy));
}

/** Bounded local search, no database access, no moving other appointments. */
function planStaffAttention({ resource, start, end, policies, reserved = [] }) {
  const first = +new Date(start), last = +new Date(end);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return null;
  const fixed = [], tasks = [];
  for (const input of policies) {
    const policy = normalizeAttentionPolicy(input);
    if (policy.mode === 'continuous') {
      const interval = { start: first + policy.patient_preparation_minutes * MINUTE, end: last, kind: 'continuous' };
      if (interval.start >= last || !free(resource, interval, reserved)) return null;
      fixed.push(interval);
    } else {
      if (policy.start_window_minutes * MINUTE > last - first || policy.end_window_minutes * MINUTE > last - first
        || (policy.start_minutes + policy.end_minutes) * MINUTE > last - first) return null;
      tasks.push({ kind: 'start', earliest: first, latest: first + (policy.start_window_minutes - policy.start_minutes) * MINUTE, duration: policy.start_minutes * MINUTE });
      tasks.push({ kind: 'end', earliest: last - policy.end_window_minutes * MINUTE, latest: last - policy.end_minutes * MINUTE, duration: policy.end_minutes * MINUTE });
    }
  }
  // Multiple continuous requirements can share the same clinician. Their union
  // is occupied, while distinct machine setup/removal tasks cannot overlap it.
  const selected = [];
  let explored = 0;
  tasks.sort((a, b) => (a.latest - a.earliest) - (b.latest - b.earliest) || a.earliest - b.earliest);
  function visit(index) {
    if (index === tasks.length) return true;
    const task = tasks[index];
    for (let time = task.earliest; time <= task.latest; time += 5 * MINUTE) {
      if (++explored > 512) return false;
      const interval = { start: time, end: time + task.duration, kind: task.kind };
      if (!free(resource, interval, [...reserved, ...fixed, ...selected])) continue;
      selected.push(interval);
      if (visit(index + 1)) return true;
      selected.pop();
    }
    return false;
  }
  if (!visit(0)) return null;
  const intervals = [...fixed, ...selected].sort((a, b) => a.start - b.start);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start < previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged.map(interval => ({ start_at: new Date(interval.start).toISOString(), end_at: new Date(interval.end).toISOString(), kind: interval.kind }));
}

function validStaffIntervals(phase, policies) {
  if (!Array.isArray(phase.staff_intervals) || !phase.staff_intervals.length || phase.staff_intervals.length > 17) return false;
  const first = +new Date(phase.start_at), last = +new Date(phase.end_at);
  const intervals = phase.staff_intervals.map(interval => ({ start: +new Date(interval?.start_at), end: +new Date(interval?.end_at), kind: interval?.kind }));
  if (intervals.some(interval => !Number.isFinite(interval.start) || !Number.isFinite(interval.end) || interval.start < first || interval.end > last || interval.start >= interval.end)
    || intervals.some((interval, index) => intervals.slice(index + 1).some(other => overlaps(interval, other)))) return false;
  const expected = [];
  const continuousPolicies = policies.filter(policy => policy.mode === 'continuous');
  if (continuousPolicies.length) expected.push({ kind: 'continuous', start: first + Math.min(...continuousPolicies.map(policy => policy.patient_preparation_minutes)) * MINUTE, end: last });
  for (const policy of policies.filter(policy => policy.mode === 'start_end')) {
    expected.push({ kind: 'start', duration: policy.start_minutes * MINUTE, earliest: first, latest: first + (policy.start_window_minutes - policy.start_minutes) * MINUTE });
    expected.push({ kind: 'end', duration: policy.end_minutes * MINUTE, earliest: last - policy.end_window_minutes * MINUTE, latest: last - policy.end_minutes * MINUTE });
  }
  if (expected.length !== intervals.length) return false;
  const used = new Set();
  let steps = 0;
  function match(index) {
    if (index === expected.length) return true;
    const requirement = expected[index];
    for (let i = 0; i < intervals.length; i++) {
      if (++steps > 512) return false;
      const interval = intervals[i];
      if (used.has(i) || interval.kind !== requirement.kind) continue;
      if (requirement.kind === 'continuous' ? interval.start !== requirement.start || interval.end !== requirement.end
        : interval.end - interval.start !== requirement.duration || interval.start < requirement.earliest || interval.start > requirement.latest
          || (interval.start - requirement.earliest) % (5 * MINUTE)) continue;
      used.add(i); if (match(index + 1)) return true; used.delete(i);
    }
    return false;
  }
  return match(0);
}

/** Ordinary consultations can be doubled by the booking operator, not by a
 * prior professional/room permission. Keep old policy columns as historical
 * data, but never use their flags or capacity to gate this confirmation.
 * Blocks, foreign occupancy and technical reservations remain non-shareable. */
function resourceForConfirmedOverlap(resource, start, end, enabled) {
  if (!enabled || !resource) return resource;
  const relevant = (resource.busy || []).filter(busy => +new Date(busy.start) < +end && +new Date(busy.end) > +start);
  if (!relevant.length || relevant.some(busy => busy.can_share !== true)) return resource;
  return { ...resource, busy: (resource.busy || []).filter(busy => busy.can_share !== true) };
}

// The new appointment's technical requirements are protected too: a manual
// consultation override cannot invent free staff time for a machine or team.
function ordinaryPhaseCanOverlap(phase) {
  return phase.professionals.mode === 'any' && !(phase.equipment_requirements || []).length
    && !(phase.staff_attention || []).length;
}

module.exports = { normalizeAttentionPolicy, isDefaultAttention, planStaffAttention, validStaffIntervals, resourceForConfirmedOverlap, ordinaryPhaseCanOverlap };
