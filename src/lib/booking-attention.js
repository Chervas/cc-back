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
  const initialOnly = ['start_only', 'start_continuous'].includes(input.mode);
  const allowed = ['mode', 'start_minutes', 'start_window_minutes', ...(initialOnly ? [] : ['end_minutes', 'end_window_minutes'])];
  if ((!initialOnly && input.mode !== 'start_end') || Object.keys(input).some(key => !allowed.includes(key))) invalid('Elige atención continua, preparación inicial o intervención al inicio y al final.');
  const policy = { mode: input.mode,
    start_minutes: minutes(input.start_minutes, 'Intervención inicial', 5, 30),
    start_window_minutes: minutes(input.start_window_minutes, 'Ventana inicial', 5, 60),
    ...(!initialOnly ? { end_minutes: minutes(input.end_minutes, 'Intervención final', 5, 30),
      end_window_minutes: minutes(input.end_window_minutes, 'Ventana final', 5, 60) } : {}) };
  if (policy.start_minutes > policy.start_window_minutes || (!initialOnly && policy.end_minutes > policy.end_window_minutes)) invalid('La intervención debe caber completa dentro de su ventana.');
  return policy;
}
const isDefaultAttention = policy => policy.mode === 'continuous' && policy.patient_preparation_minutes === 0;
const requiresVersion4Attention = policy => ['start_only', 'start_continuous'].includes(policy.mode);
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
function free(resource, interval, reserved) {
  return resource?.windows?.some(window => +new Date(window.start) <= interval.start && interval.end <= +new Date(window.end))
    && !(resource.busy || []).some(busy => overlaps(interval, { start: +new Date(busy.start), end: +new Date(busy.end) }))
    && !reserved.some(busy => overlaps(interval, busy));
}

/** Bounded local search, no database access, no moving other appointments. */
function planStaffAttention({ resource, start, end, policies, reserved = [] }) {
  return planStaffAttentionSteps({ resource, steps: [{ key: 'phase', start, end, policies }], reserved, maxAttempts: 512 })?.[0].staff_intervals || null;
}

/** A limited search is not proof of impossibility or a clinical absence.
 * Keep the legacy plan-or-null API unchanged; evidence consumers use this
 * explicit decision and fail closed on invalid or exhausted searches. */
function assessStaffAttention({ resource, start, end, policies, reserved = [], maxAttempts = 512 }) {
  const decision = assessStaffAttentionSteps({ resource, steps: [{ key: 'phase', start, end, policies }], reserved, maxAttempts });
  return decision.status === 'planned' ? { status: 'planned', staff_intervals: decision.steps[0].staff_intervals }
    : { status: decision.status };
}

/** Joint search for the steps of ONE proposed visit. Existing reservations are
 * always fixed. This is not permission to rearrange another patient's tasks.
 * A setup followed by continuous care is one indivisible occupied span; the
 * split in the result documents the two kinds of work, not a free gap. */
function planStaffAttentionSteps(options) {
  const decision = assessStaffAttentionSteps(options);
  return decision.status === 'planned' ? decision.steps : null;
}

function assessStaffAttentionSteps({ resource, steps, reserved = [], maxAttempts = 4096 }) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 12 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4096) return { status: 'invalid' };
  const fixed = [], tasks = [], keys = new Set();
  let invalidInput = false;
  for (const step of steps) {
    if (!step || typeof step.key !== 'string' || keys.has(step.key) || !Array.isArray(step.policies) || !step.policies.length || step.policies.length > 8) return { status: 'invalid' };
    keys.add(step.key);
    if (!addStep(step)) return { status: invalidInput ? 'invalid' : 'infeasible' };
  }
  function addStep({ key, start, end, policies, resource: phaseResource = resource }) {
    const first = +new Date(start), last = +new Date(end);
    if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) { invalidInput = true; return false; }
    const continuousPolicies = [];
    for (const input of policies) {
      const policy = normalizeAttentionPolicy(input);
      if (policy.mode === 'continuous') {
        continuousPolicies.push(policy);
      } else {
        if (policy.start_window_minutes * MINUTE > last - first
          || (policy.mode === 'start_end' && (policy.end_window_minutes * MINUTE > last - first
          || (policy.start_minutes + policy.end_minutes) * MINUTE > last - first))
          || (policy.mode === 'start_continuous' && policy.start_minutes * MINUTE >= last - first)) { invalidInput = true; return false; }
        tasks.push({ key, resource: phaseResource, kind: 'start', earliest: first, latest: first + (policy.start_window_minutes - policy.start_minutes) * MINUTE,
          duration: policy.start_minutes * MINUTE, ...(policy.mode === 'start_continuous' ? { continuousEnd: last } : {}) });
        if (policy.mode === 'start_end') tasks.push({ key, resource: phaseResource, kind: 'end', earliest: last - policy.end_window_minutes * MINUTE,
          latest: last - policy.end_minutes * MINUTE, duration: policy.end_minutes * MINUTE });
      }
    }
    // Several policies in the same step may require the same continuous work.
    // Distinct steps, unlike these overlapping requirements, cannot share staff.
    if (continuousPolicies.length) {
      const interval = { key, start: first + Math.min(...continuousPolicies.map(policy => policy.patient_preparation_minutes)) * MINUTE, end: last, kind: 'continuous' };
      if (interval.start >= last) { invalidInput = true; return false; }
      if (!free(phaseResource, interval, [...reserved, ...fixed])) return false;
      fixed.push(interval);
    }
    return true;
  }
  const selected = [];
  let explored = 0;
  let exhausted = false;
  tasks.sort((a, b) => (a.latest - a.earliest) - (b.latest - b.earliest) || a.earliest - b.earliest);
  function visit(index) {
    if (exhausted) return false;
    if (index === tasks.length) return true;
    const task = tasks[index];
    // Later setup for a subsequent attended application preserves capacity for
    // other initial preparations. Backtracking still checks every candidate.
    for (let time = task.continuousEnd ? task.latest : task.earliest;
      task.continuousEnd ? time >= task.earliest : time <= task.latest;
      time += (task.continuousEnd ? -1 : 1) * 5 * MINUTE) {
      if (++explored > maxAttempts) { exhausted = true; return false; }
      if (task.continuousEnd && time + task.duration >= task.continuousEnd) continue;
      const interval = { key: task.key, start: time, end: task.continuousEnd || time + task.duration, kind: task.kind,
        ...(task.continuousEnd ? { setupEnd: time + task.duration } : {}) };
      if (!free(task.resource, interval, [...reserved, ...fixed, ...selected])) continue;
      selected.push(interval);
      if (visit(index + 1)) return true;
      selected.pop();
    }
    return false;
  }
  if (!visit(0)) return { status: exhausted ? 'search_limit' : 'infeasible' };
  const intervals = [...fixed, ...selected.flatMap(interval => interval.setupEnd ? [
    { ...interval, end: interval.setupEnd }, { ...interval, start: interval.setupEnd, kind: 'continuous' },
  ] : [interval])].sort((a, b) => a.start - b.start);
  return { status: 'planned', steps: steps.map(step => ({ key: step.key, staff_intervals: intervals.filter(interval => interval.key === step.key)
    .map(interval => ({ start_at: new Date(interval.start).toISOString(), end_at: new Date(interval.end).toISOString(), kind: interval.kind })) })) };
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
  for (const policy of policies.filter(policy => ['start_end', 'start_only', 'start_continuous'].includes(policy.mode))) {
    expected.push({ kind: 'start', duration: policy.start_minutes * MINUTE, earliest: first, latest: first + (policy.start_window_minutes - policy.start_minutes) * MINUTE });
    if (policy.mode === 'start_end') expected.push({ kind: 'end', duration: policy.end_minutes * MINUTE, earliest: last - policy.end_window_minutes * MINUTE, latest: last - policy.end_minutes * MINUTE });
    if (policy.mode === 'start_continuous') expected.push({ kind: 'continuous_after_setup', end: last,
      setupRequirement: expected.length - 1 });
  }
  if (expected.length !== intervals.length) return false;
  const used = new Set(), matches = new Map();
  let steps = 0;
  function match(index) {
    if (index === expected.length) return true;
    const requirement = expected[index];
    for (let i = 0; i < intervals.length; i++) {
      if (++steps > 512) return false;
      const interval = intervals[i];
      if (used.has(i) || interval.kind !== (requirement.kind === 'continuous_after_setup' ? 'continuous' : requirement.kind)) continue;
      if (requirement.kind === 'continuous_after_setup' ? interval.start !== matches.get(requirement.setupRequirement)?.end || interval.end !== requirement.end
        : requirement.kind === 'continuous' ? interval.start !== requirement.start || interval.end !== requirement.end
        : interval.end - interval.start !== requirement.duration || interval.start < requirement.earliest || interval.start > requirement.latest
          || (interval.start - requirement.earliest) % (5 * MINUTE)) continue;
      used.add(i); matches.set(index, interval); if (match(index + 1)) return true; used.delete(i); matches.delete(index);
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

module.exports = { normalizeAttentionPolicy, isDefaultAttention, requiresVersion4Attention, planStaffAttention, planStaffAttentionSteps, assessStaffAttention, assessStaffAttentionSteps,
  validStaffIntervals, resourceForConfirmedOverlap, ordinaryPhaseCanOverlap };
